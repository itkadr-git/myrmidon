"""LiteLLM guardrail adapter for the myrmidon-redact (RD1) HTTP service.

The adapter deliberately makes blocking decisions from the service score, not
from whether the response contains an entity. It uses only the Python standard
library so it can be copied into a LiteLLM deployment without new dependencies.
"""

from __future__ import annotations

import json
import asyncio
import logging
import os
from dataclasses import dataclass
from typing import Any, Callable
from urllib.request import Request, urlopen


logger = logging.getLogger(__name__)


class RedactGuardrailBlocked(RuntimeError):
    """Raised when RD1 reports a score at or above the configured threshold."""


@dataclass(frozen=True)
class GuardrailConfig:
    url: str
    mode: str = "flag"
    threshold: float = 0.8
    timeout_seconds: float = 2.0

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "GuardrailConfig":
        values = env if env is not None else os.environ
        url = values.get("MYRMIDON_REDACT_URL", "http://myrmidon-redact:8080/v1/scan").strip()
        mode = values.get("MYRMIDON_REDACT_MODE", "flag").strip().lower()
        if mode not in {"flag", "mask", "block"}:
            raise ValueError("MYRMIDON_REDACT_MODE must be flag, mask, or block")
        threshold = float(values.get("MYRMIDON_REDACT_SCORE", "0.8"))
        if not 0 <= threshold <= 1:
            raise ValueError("MYRMIDON_REDACT_SCORE must be between 0 and 1")
        timeout = float(values.get("MYRMIDON_REDACT_TIMEOUT_SECONDS", "2"))
        if timeout <= 0:
            raise ValueError("MYRMIDON_REDACT_TIMEOUT_SECONDS must be positive")
        return cls(url=url, mode=mode, threshold=threshold, timeout_seconds=timeout)


class LiteLLMRedactGuardrail:
    """LiteLLM ``CustomGuardrail`` compatible pre/post call adapter."""

    def __init__(
        self,
        config: GuardrailConfig | None = None,
        *,
        transport: Callable[[str, dict[str, Any], float], dict[str, Any]] | None = None,
    ) -> None:
        self.config = config or GuardrailConfig.from_env()
        self._transport = transport or self._http_transport

    @staticmethod
    def _http_transport(url: str, payload: dict[str, Any], timeout: float) -> dict[str, Any]:
        request = Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"content-type": "application/json", "accept": "application/json"},
            method="POST",
        )
        with urlopen(request, timeout=timeout) as response:
            result = json.loads(response.read().decode("utf-8"))
        if not isinstance(result, dict):
            raise ValueError("RD1 response must be a JSON object")
        return result

    def _scan(self, text: str, *, stage: str) -> dict[str, Any]:
        return self._transport(
            self.config.url,
            {"text": text, "stage": stage, "mode": self.config.mode},
            self.config.timeout_seconds,
        )

    def _score(self, result: dict[str, Any]) -> float:
        if "score" not in result:
            raise ValueError("RD1 response is missing score")
        try:
            score = float(result["score"])
        except (TypeError, ValueError) as exc:
            raise ValueError("RD1 response score must be numeric") from exc
        if not 0 <= score <= 1:
            raise ValueError("RD1 response score must be between 0 and 1")
        return score

    def _apply(self, text: str, *, stage: str) -> str:
        try:
            result = self._scan(text, stage=stage)
            score = self._score(result)
        except Exception:
            if self.config.mode == "block":
                raise
            logger.exception("RD1 %s scan failed; passing payload unchanged", stage)
            return text
        if self.config.mode == "block" and score >= self.config.threshold:
            raise RedactGuardrailBlocked(
                f"myrmidon-redact blocked {stage} payload (score={score:.3f})"
            )
        if self.config.mode == "mask" and score < self.config.threshold:
            return text
        if self.config.mode == "mask":
            replacement = result.get("text", result.get("redacted_text", text))
            return replacement if isinstance(replacement, str) else text
        return text

    async def async_pre_call_hook(self, user_api_key: str, cache: Any, data: dict[str, Any], process_id: str) -> dict[str, Any]:
        """Scan message content before LiteLLM sends the provider request."""
        del user_api_key, cache, process_id
        payload = dict(data)
        messages = []
        for message in payload.get("messages", []):
            if not isinstance(message, dict) or not isinstance(message.get("content"), str):
                messages.append(message)
                continue
            updated = dict(message)
            updated["content"] = await asyncio.to_thread(self._apply, message["content"], stage="pre_call")
            messages.append(updated)
        if self.config.mode == "flag":
            return data
        payload["messages"] = messages
        return payload

    async def async_post_call_success_hook(
        self, data: dict[str, Any], user_api_key_dict: Any, response: Any
    ) -> Any:
        """Scan provider output; mask it when configured, or block by score."""
        text = _response_text(response)
        if text is None:
            return response
        updated_text = await asyncio.to_thread(self._apply, text, stage="post_call")
        if self.config.mode != "mask" or updated_text == text:
            return response
        return _replace_response_text(response, updated_text)


def _response_text(response: Any) -> str | None:
    if isinstance(response, dict):
        choices = response.get("choices")
        if isinstance(choices, list) and choices and isinstance(choices[0], dict):
            message = choices[0].get("message")
            if isinstance(message, dict) and isinstance(message.get("content"), str):
                return message["content"]
    message = getattr(response, "choices", None)
    if message and isinstance(getattr(message[0], "message", None), object):
        content = getattr(message[0].message, "content", None)
        return content if isinstance(content, str) else None
    return None


def _replace_response_text(response: Any, text: str) -> Any:
    if isinstance(response, dict):
        cloned = json.loads(json.dumps(response))
        cloned["choices"][0]["message"]["content"] = text
        return cloned
    response.choices[0].message.content = text
    return response


custom_guardrail = LiteLLMRedactGuardrail
