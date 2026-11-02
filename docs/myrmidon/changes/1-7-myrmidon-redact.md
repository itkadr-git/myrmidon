---
divergence-section: Трек 6 — безопасность и модели
---

## changelog-en

### REDACT: Sensitive data masking, entity detection, and guardrails (1.7-REDACT)

- Added standalone `myrmidon-redact` module in `tools/redact`.
- Implemented offline regex and checksum recognizers for INN, KPP, OGRN/OGRNIP, OKPO, bank accounts, BIC, bank cards (Luhn), SNILS, Russian passport, and secrets (API keys, tokens, passwords).
- Implemented `RedactEngine` supporting flag-only, irreversible masking, and reversible masking with TTL substitution store restoring text byte-for-byte.
- Added HTTP service endpoints `/healthz`, `/redact`, `/restore`, and `/scan`.
- Added MCP server exposing `redact_text`, `restore_text`, and `scan_text`.
- Added LiteLLM guardrail adapter with score-based gating avoiding binary presence blocking.
- Added CI workflow `.github/workflows/myrmidon-redact.yml` and container build artifacts.
- Added synthetic benchmark suite verifying recall >= 0.95, false positive rate <= 0.02, and latency < 150ms on 4 KiB payload.
- Added documentation in `docs/myrmidon/redact.md` and `docs/myrmidon/redact.ru.md`.

## changelog-ru

### REDACT: Модуль маскирования чувствительных данных, распознавание сущностей и guardrails (1.7-REDACT)

- Добавлен отдельный модуль `myrmidon-redact` в `tools/redact`.
- Реализованы offline-распознаватели регулярных выражений и контрольных сумм для ИНН, КПП, ОГРН/ОГРНИП, ОКПО, банковских счетов, БИК, банковских карт (Luhn), СНИЛС, паспорта РФ и секретов (API-ключи, токены, пароли).
- Реализован `RedactEngine` с поддержкой режимов «только флаг», необратимого маскирования и обратимого маскирования с TTL-хранилищем подстановок с побайтовым восстановлением.
- Добавлены эндпоинты HTTP-сервиса `/healthz`, `/redact`, `/restore` и `/scan`.
- Добавлен MCP-сервер с инструментами `redact_text`, `restore_text` и `scan_text`.
- Добавлен адаптер LiteLLM guardrail с взвешенным скорингом без бинарных блокировок.
- Добавлен рабочий процесс CI `.github/workflows/myrmidon-redact.yml` и сборка контейнера.
- Добавлен набор синтетических бенчмарков, подтверждающий полноту >= 0.95, долю ложных срабатываний <= 0.02 и задержку < 150 мс на 4 КБ текста.
- Добавлена документация в `docs/myrmidon/redact.md` и `docs/myrmidon/redact.ru.md`.
