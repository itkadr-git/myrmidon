# LiteLLM REDACT guardrail adapter

`tools/redact/litellm_guardrail.py` is a dependency-free LiteLLM custom guardrail adapter for the RD1 `myrmidon-redact` HTTP endpoint. It supports `async_pre_call_hook` and `async_post_call_success_hook`-compatible entry points and sends `stage`, `mode`, and text to RD1.

The `block` decision is based on `score >= threshold`; a non-empty entity list alone never blocks. `flag` scans but returns the original LiteLLM payload unchanged. `mask` uses RD1's returned `text` or `redacted_text` only when the score reaches the threshold.

Configuration is read at startup from the operator-provided environment:

- `MYRMIDON_REDACT_URL` (default `http://myrmidon-redact:8080/v1/scan`)
- `MYRMIDON_REDACT_MODE`: `flag`, `mask`, or `block` (default `flag`)
- `MYRMIDON_REDACT_SCORE`: threshold from 0 to 1 (default `0.8`)
- `MYRMIDON_REDACT_TIMEOUT_SECONDS` (default `2`)

Deployment and LiteLLM configuration wiring remain operator-owned; this change only supplies the adapter interface.
