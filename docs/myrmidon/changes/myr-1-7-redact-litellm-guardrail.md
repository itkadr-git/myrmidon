---
settings-section: Track 1 — platform
divergence-section: Трек 1 — платформа
---

## changelog-en

### Add LiteLLM REDACT guardrail adapter (REDACT)

- Add an RD1-backed pre-call/post-call adapter with score-threshold blocking and flag mode payload preservation.

## changelog-ru

### Добавлен адаптер REDACT для LiteLLM (REDACT)

- Добавлен адаптер RD1 для pre_call/post_call с блокировкой по порогу score и сохранением payload в режиме flag.

## divergence

| REDACT | LiteLLM REDACT adapter | `tools/redact/litellm_guardrail.py` | RD1 guardrail integration | adapter tests | remove adapter | #1527 |

## settings-en

| `MYRMIDON_REDACT_URL` / `MYRMIDON_REDACT_MODE` / `MYRMIDON_REDACT_SCORE` / `MYRMIDON_REDACT_TIMEOUT_SECONDS` | REDACT | `http://myrmidon-redact:8080/v1/scan` / `flag` / `0.8` / `2` | Configure the RD1 LiteLLM adapter from the operator-provided environment at process startup. | Unset variables to use defaults. |

## settings-ru

| `MYRMIDON_REDACT_URL` / `MYRMIDON_REDACT_MODE` / `MYRMIDON_REDACT_SCORE` / `MYRMIDON_REDACT_TIMEOUT_SECONDS` | REDACT | `http://myrmidon-redact:8080/v1/scan` / `flag` / `0.8` / `2` | Настройка адаптера RD1 для LiteLLM из окружения оператора при старте процесса. | Не задавать переменные для значений по умолчанию. |
