"""LiteLLM Guardrail Adapter for Myrmidon REDACT.

Provides pre_call and post_call hooks with score-based gating.
Compatible with LiteLLM CustomGuardrail.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.request
import urllib.error
from typing import Any, Dict, List, Optional, Tuple

from .engine import RedactEngine, RedactMode

logger = logging.getLogger("myrmidon_redact.litellm")


class LiteLLMRedactGuardrail:
    """LiteLLM guardrail adapter with score-based decision making.

    Avoids the common pitfall of blocking on any entity match without score weighting.
    """

    def __init__(
        self,
        service_url: Optional[str] = None,
        mode: str = "flag",
        threshold: float = 0.85,
        reversible: bool = True,
        ttl_seconds: int = 3600,
        local_engine: Optional[RedactEngine] = None,
    ):
        self.service_url = service_url or os.environ.get("REDACT_SERVICE_URL")
        self.mode = mode or os.environ.get("REDACT_MODE", "flag")
        self.threshold = float(os.environ.get("REDACT_THRESHOLD", str(threshold)))
        self.reversible = reversible
        self.ttl_seconds = ttl_seconds
        self.local_engine = local_engine or RedactEngine()

    def _call_service_redact(self, text: str) -> Dict[str, Any]:
        if not self.service_url:
            res = self.local_engine.redact(
                text=text,
                mode=self.mode,
                reversible=self.reversible,
                ttl_seconds=self.ttl_seconds,
            )
            return res.to_dict()

        url = f"{self.service_url.rstrip('/')}/redact"
        data = json.dumps({
            "text": text,
            "mode": self.mode,
            "reversible": self.reversible,
            "ttl_seconds": self.ttl_seconds,
        }).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=data,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=5.0) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            logger.warning(f"Failed to call redact service at {url}: {e}, falling back to local engine")
            res = self.local_engine.redact(
                text=text,
                mode=self.mode,
                reversible=self.reversible,
                ttl_seconds=self.ttl_seconds,
            )
            return res.to_dict()

    def _call_service_restore(self, text: str, tokens: Optional[Dict[str, str]] = None) -> str:
        if not self.service_url:
            return self.local_engine.restore(text, tokens=tokens)

        url = f"{self.service_url.rstrip('/')}/restore"
        data = json.dumps({"text": text, "tokens": tokens or {}}).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=data,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=5.0) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
                return payload.get("text", text)
        except Exception as e:
            logger.warning(f"Failed to call restore service at {url}: {e}, falling back to local engine")
            return self.local_engine.restore(text, tokens=tokens)

    def pre_call_hook(
        self,
        user_prompt: Optional[str] = None,
        messages: Optional[List[Dict[str, Any]]] = None,
        **kwargs: Any,
    ) -> Tuple[Optional[str], Optional[List[Dict[str, Any]]], Dict[str, Any]]:
        """Pre-call hook executed before sending prompt to LLM.

        Returns (modified_prompt, modified_messages, metadata).
        In FLAG mode, requests are never blocked.
        """
        metadata: Dict[str, Any] = {"guardrail": "myrmidon-redact", "flagged": False, "score": 0.0}

        if user_prompt is not None:
            res = self._call_service_redact(user_prompt)
            metadata["score"] = res.get("score", 0.0)
            metadata["flagged"] = res.get("flagged", False)
            metadata["matches"] = res.get("matches", [])
            metadata["tokens"] = res.get("tokens", {})

            if self.mode == "block" and metadata["score"] >= self.threshold:
                raise ValueError(
                    f"Request blocked by guardrail: sensitive data detected with score {metadata['score']:.2f} >= threshold {self.threshold:.2f}"
                )

            if self.mode == "mask":
                user_prompt = res.get("text", user_prompt)

        elif messages is not None:
            new_messages = []
            max_score = 0.0
            any_flagged = False
            all_tokens: Dict[str, str] = {}
            for msg in messages:
                content = msg.get("content")
                if isinstance(content, str):
                    res = self._call_service_redact(content)
                    score = res.get("score", 0.0)
                    if score > max_score:
                        max_score = score
                    if res.get("flagged", False):
                        any_flagged = True
                    all_tokens.update(res.get("tokens", {}))
                    if self.mode == "mask":
                        msg = dict(msg, content=res.get("text", content))
                new_messages.append(msg)

            metadata["score"] = max_score
            metadata["flagged"] = any_flagged
            metadata["tokens"] = all_tokens

            if self.mode == "block" and metadata["score"] >= self.threshold:
                raise ValueError(
                    f"Request blocked by guardrail: sensitive data detected with score {metadata['score']:.2f} >= threshold {self.threshold:.2f}"
                )

            messages = new_messages

        return user_prompt, messages, metadata

    def post_call_success_hook(
        self,
        response_text: str,
        tokens: Optional[Dict[str, str]] = None,
        **kwargs: Any,
    ) -> str:
        """Post-call hook executed after LLM response is received.

        If reversible substitution was performed, restores tokens back to original values.
        """
        if self.mode == "mask" and self.reversible:
            return self._call_service_restore(response_text, tokens=tokens)
        return response_text

    async def async_pre_call_hook(
        self,
        user_prompt: Optional[str] = None,
        messages: Optional[List[Dict[str, Any]]] = None,
        **kwargs: Any,
    ) -> Tuple[Optional[str], Optional[List[Dict[str, Any]]], Dict[str, Any]]:
        return self.pre_call_hook(user_prompt=user_prompt, messages=messages, **kwargs)

    async def async_post_call_success_hook(
        self,
        response_text: str,
        tokens: Optional[Dict[str, str]] = None,
        **kwargs: Any,
    ) -> str:
        return self.post_call_success_hook(response_text, tokens=tokens, **kwargs)
