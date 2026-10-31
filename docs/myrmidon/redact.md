# Myrmidon REDACT

Standalone sensitive data masking, legal entity requisites detection, and guardrails service (`myrmidon-redact`).

## Overview

`myrmidon-redact` provides high-performance, purely offline recognition and masking of:
- **Personal Data (PII)**: Full names (FIO), phone numbers, email addresses, Russian passport, SNILS with checksum validation.
- **Legal Entity Requisites**: INN (10 and 12 digits with official checksum), KPP, OGRN (13 digits) and OGRNIP (15 digits) with modulo checks, OKPO (8 and 10 digits).
- **Banking**: Settlement accounts (р/с), correspondent accounts (к/с), BIC (БИК 04...), bank cards with Luhn checksum algorithm.
- **Secrets**: API keys (OpenAI, Anthropic, GitHub, AWS, Slack, GitLab), JWT tokens, private keys (`-----BEGIN PRIVATE KEY-----`), password assignments.
- **Nest Specifics**: Counterparties and signatories dictionaries, custom contract/invoice numbering patterns.

## Architecture and Integration Modes

The module supports three primary consumption paths:
1. **HTTP Service**: Independent container exposing `/healthz`, `/redact`, `/restore`, `/scan`.
2. **LiteLLM Guardrail Adapter**: Drop-in `pre_call_hook` and `post_call_success_hook` with score-based gating (avoids binary blocking on presence alone).
3. **MCP Tool Server**: Model Context Protocol JSON-RPC over stdio for container bots (`redact_text`, `restore_text`, `scan_text`).

### Operational Modes

- `flag`: Detects entities, calculates overall risk score, populates match metadata. Never blocks or alters input text.
- `mask`: Replaces sensitive tokens:
  - **Irreversible**: `[REDACTED_<KIND>]`
  - **Reversible**: `<SUB:<KIND>:<UUID>>` with expiring TTL substitution storage. Restores original text byte-for-byte via `/restore`.
- `block`: Fails fast if overall risk score meets or exceeds configured threshold (default `0.85`).

## HTTP API Specification

### `GET /healthz`
Health check endpoint.
```json
{
  "status": "ok",
  "service": "myrmidon-redact",
  "version": "1.7.0"
}
```

### `POST /redact`
Request:
```json
{
  "text": "Договор с ООО Альфа, ИНН 7707083893, оплата на р/с 40702810938000012345.",
  "mode": "mask",
  "reversible": true,
  "ttl_seconds": 3600
}
```
Response:
```json
{
  "text": "Договор с ООО Альфа, ИНН <SUB:INN:a1b2c3d4e5f6>, оплата на р/с <SUB:BANK_ACCOUNT:7890abcdef12>.",
  "score": 0.98,
  "flagged": true,
  "matches": [
    {
      "entity_type": "INN",
      "text": "7707083893",
      "start": 25,
      "end": 35,
      "score": 0.98
    }
  ],
  "tokens": {
    "<SUB:INN:a1b2c3d4e5f6>": "7707083893"
  }
}
```

### `POST /restore`
Restores reversible substitution tokens byte-for-byte.
```json
{
  "text": "Ответ модели с <SUB:INN:a1b2c3d4e5f6>",
  "tokens": {
    "<SUB:INN:a1b2c3d4e5f6>": "7707083893"
  }
}
```

## LiteLLM Guardrail Integration

Add to LiteLLM configuration:
```python
from myrmidon_redact.litellm_guardrail import LiteLLMRedactGuardrail

guardrail = LiteLLMRedactGuardrail(
    service_url="http://myrmidon-redact:8080",
    mode="flag",  # 'flag', 'mask', or 'block'
    threshold=0.85,
    reversible=True,
)
```

## Acceptance Benchmark Results

Synthetic benchmark assertions verified in CI:
- **Recall**: >= 0.95 for INN, OGRN, bank accounts, BIC, cards, and secrets.
- **False Positive Rate**: <= 0.02 across invalid checksums and benign conversational texts.
- **Restoration**: Byte-for-byte exact match on reversible substitution.
- **Latency**: < 15 ms on 4 KiB text payloads (threshold: <= 150 ms).
- **Network**: Purely offline execution without external outbound network calls.
