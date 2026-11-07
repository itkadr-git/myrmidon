## changelog-en

### Bots read the board key and address as MYRMIDON_API_KEY / MYRMIDON_API_URL (REBRAND-ENV)

- The `execute_code` pass-through list in the bot profile (`terminal.env_passthrough`) now carries `MYRMIDON_API_KEY` and `MYRMIDON_API_URL` ahead of the legacy `PAPERCLIP_API_KEY` / `PAPERCLIP_API_URL`; the `hermes/.env` of the bot already holds both pairs with the same values. The bot skill (`auth-and-run-context.md`) names `MYRMIDON_*` as the variables to read and `PAPERCLIP_*` as the deprecated alias.
- The bot disk agent `botd` (desired-state poll and disk report) reads `MYRMIDON_API_URL` / `MYRMIDON_API_KEY` first and falls back to `PAPERCLIP_API_URL` / `PAPERCLIP_API_KEY` when the canonical one is missing or empty, so a bot image older than the board keeps working. The key is redacted from reasons and logs under either name; the "not set" reasons now name the `MYRMIDON_*` variable.

## changelog-ru

### Боты читают ключ и адрес доски как MYRMIDON_API_KEY / MYRMIDON_API_URL (REBRAND-ENV)

- Список переменных для `execute_code` в профиле бота (`terminal.env_passthrough`) теперь содержит `MYRMIDON_API_KEY` и `MYRMIDON_API_URL` перед прежними `PAPERCLIP_API_KEY` / `PAPERCLIP_API_URL`; в `hermes/.env` бота обе пары уже лежат с одинаковыми значениями. Навык бота (`auth-and-run-context.md`) называет читаемыми `MYRMIDON_*`, а `PAPERCLIP_*` — устаревшим синонимом.
- Агент диска бота `botd` (опрос желаемого состояния и отчёт о диске) читает `MYRMIDON_API_URL` / `MYRMIDON_API_KEY` первыми и берёт `PAPERCLIP_API_URL` / `PAPERCLIP_API_KEY`, только если каноническая переменная не задана или пуста, поэтому образ бота старее доски продолжает работать. Ключ вырезается из причин и журналов под любым из двух имён; причины «не задан» теперь называют переменную `MYRMIDON_*`.
