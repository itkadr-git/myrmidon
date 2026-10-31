"""Core Redaction Engine.

Supports flag-only, irreversible masking, and reversible masking with expiring TTL substitution store.
"""

from __future__ import annotations

import enum
import time
import uuid
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Any

from .recognizers import RecognizerRegistry, create_default_registry, NestDictionaryRecognizer


class RedactMode(str, enum.Enum):
    FLAG = "flag"
    MASK = "mask"
    BLOCK = "block"


@dataclass
class EntityMatch:
    entity_type: str
    text: str
    start: int
    end: int
    score: float
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "entity_type": self.entity_type,
            "text": self.text,
            "start": self.start,
            "end": self.end,
            "score": self.score,
            "metadata": self.metadata,
        }


class SubstitutionStore:
    def __init__(self, default_ttl_seconds: int = 3600):
        self.default_ttl_seconds = default_ttl_seconds
        # token -> (original_text, expires_at)
        self._store: Dict[str, tuple[str, float]] = {}

    def put(self, token: str, original_text: str, ttl_seconds: Optional[int] = None) -> None:
        ttl = ttl_seconds if ttl_seconds is not None else self.default_ttl_seconds
        expires_at = time.time() + ttl
        self._store[token] = (original_text, expires_at)

    def get(self, token: str) -> Optional[str]:
        self._prune_expired()
        entry = self._store.get(token)
        if entry is None:
            return None
        original_text, expires_at = entry
        if time.time() > expires_at:
            del self._store[token]
            return None
        return original_text

    def _prune_expired(self) -> None:
        now = time.time()
        expired_keys = [k for k, (_, exp) in self._store.items() if now > exp]
        for k in expired_keys:
            del self._store[k]

    def clear(self) -> None:
        self._store.clear()


@dataclass
class RedactResult:
    text: str
    score: float
    flagged: bool
    matches: List[EntityMatch]
    tokens: Dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "text": self.text,
            "score": self.score,
            "flagged": self.flagged,
            "matches": [m.to_dict() for m in self.matches],
            "tokens": self.tokens,
        }


class RedactEngine:
    def __init__(
        self,
        registry: Optional[RecognizerRegistry] = None,
        store: Optional[SubstitutionStore] = None,
        block_threshold: float = 0.85,
    ):
        self.registry = registry or create_default_registry()
        self.store = store or SubstitutionStore()
        self.block_threshold = block_threshold

    def scan(
        self,
        text: str,
        counterparties: Optional[List[str]] = None,
        signatories: Optional[List[str]] = None,
        contract_patterns: Optional[List[str]] = None,
    ) -> List[EntityMatch]:
        custom_recognizer: Optional[NestDictionaryRecognizer] = None
        if counterparties or signatories or contract_patterns:
            custom_recognizer = NestDictionaryRecognizer(
                counterparties=counterparties,
                signatories=signatories,
                contract_patterns=contract_patterns,
            )

        raw_matches = self.registry.scan_all(text)
        if custom_recognizer:
            raw_matches.extend(custom_recognizer.scan(text))
            # Re-sort and deduplicate
            raw_matches.sort(key=lambda m: (m.start, -(m.end - m.start), -m.score))
            deduped = []
            last_end = -1
            for m in raw_matches:
                if m.start >= last_end:
                    deduped.append(m)
                    last_end = m.end
                else:
                    if deduped and (m.score > deduped[-1].score):
                        deduped[-1] = m
                        last_end = m.end
            raw_matches = deduped

        return [
            EntityMatch(
                entity_type=m.entity_type,
                text=m.text,
                start=m.start,
                end=m.end,
                score=m.score,
                metadata=m.metadata,
            )
            for m in raw_matches
        ]

    def redact(
        self,
        text: str,
        mode: RedactMode | str = RedactMode.MASK,
        reversible: bool = False,
        ttl_seconds: int = 3600,
        counterparties: Optional[List[str]] = None,
        signatories: Optional[List[str]] = None,
        contract_patterns: Optional[List[str]] = None,
    ) -> RedactResult:
        mode_val = RedactMode(mode) if isinstance(mode, str) else mode
        matches = self.scan(
            text,
            counterparties=counterparties,
            signatories=signatories,
            contract_patterns=contract_patterns,
        )

        overall_score = max((m.score for m in matches), default=0.0)
        flagged = len(matches) > 0

        # In FLAG mode, we never modify the text
        if mode_val == RedactMode.FLAG:
            return RedactResult(
                text=text,
                score=overall_score,
                flagged=flagged,
                matches=matches,
                tokens={},
            )

        # In BLOCK mode, we flag if score exceeds threshold
        if mode_val == RedactMode.BLOCK:
            return RedactResult(
                text=text,
                score=overall_score,
                flagged=flagged and overall_score >= self.block_threshold,
                matches=matches,
                tokens={},
            )

        # In MASK mode: perform substitution
        tokens_map: Dict[str, str] = {}
        chunks: List[str] = []
        last_idx = 0

        for match in sorted(matches, key=lambda m: m.start):
            chunks.append(text[last_idx:match.start])
            if reversible:
                tok_id = uuid.uuid4().hex[:12]
                token = f"<SUB:{match.entity_type}:{tok_id}>"
                tokens_map[token] = match.text
                self.store.put(token, match.text, ttl_seconds=ttl_seconds)
                replacement = token
            else:
                replacement = f"[REDACTED_{match.entity_type}]"
            chunks.append(replacement)
            last_idx = match.end

        chunks.append(text[last_idx:])
        redacted_text = "".join(chunks)

        return RedactResult(
            text=redacted_text,
            score=overall_score,
            flagged=flagged,
            matches=matches,
            tokens=tokens_map,
        )

    def restore(
        self,
        text: str,
        tokens: Optional[Dict[str, str]] = None,
    ) -> str:
        """Restores reversible substitutions byte-for-byte."""
        restored = text
        # If tokens are provided directly in request, use them first
        if tokens:
            for token, orig in tokens.items():
                restored = restored.replace(token, orig)

        # Also lookup any remaining tokens in store
        import re
        sub_pattern = re.compile(r"<SUB:[A-Za-z0-9_]+:[0-9a-f]{12}>")
        for match in sub_pattern.finditer(restored):
            tok = match.group(0)
            orig = self.store.get(tok)
            if orig is not None:
                restored = restored.replace(tok, orig)

        return restored
