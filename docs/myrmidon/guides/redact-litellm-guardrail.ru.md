# Адаптер REDACT для LiteLLM

`tools/redact/litellm_guardrail.py` — не зависящий от сторонних пакетов адаптер custom guardrail для LiteLLM, обращающийся к HTTP-сервису RD1 `myrmidon-redact`. Он поддерживает точки вызова `async_pre_call_hook` и `async_post_call_success_hook`, передавая в RD1 этап (`stage`), режим (`mode`) и текст.

Решение о блокировке в режиме `block` принимается по условию `score >= threshold`; само наличие сущности в ответе никогда не блокирует. В режиме `flag` выполняется проверка, но исходный payload LiteLLM возвращается без изменений. В режиме `mask` текст заменяется значением `text` или `redacted_text` RD1 только при достижении порога.

Настройки берутся при запуске из окружения, которое задаёт оператор: `MYRMIDON_REDACT_URL` (по умолчанию `http://myrmidon-redact:8080/v1/scan`), `MYRMIDON_REDACT_MODE` (`flag`, `mask`, `block`; по умолчанию `flag`), `MYRMIDON_REDACT_SCORE` (по умолчанию `0.8`) и `MYRMIDON_REDACT_TIMEOUT_SECONDS` (по умолчанию `2`). Выкладка и подключение в конфигурации LiteLLM остаются зоной ответственности оператора.
