---
settings-section: Track 4 — chats and skills
---

## settings-en

| `MYRMIDON_DISTILL_AUTO_ACCEPT` | KNOWLEDGE-2.0 K-5 | `false` | Enables automatic acceptance of eligible knowledge-distillation suggestions; disabled by default | Unset or `false` disables automatic acceptance |
| `MYRMIDON_DISTILL_GATEWAY_URL` | KNOWLEDGE-2.0 K-5 | — | OpenAI-compatible gateway endpoint used for the distillation model call | Unset uses the configured default gateway |
| `MYRMIDON_DISTILL_INTERVAL_SEC` | KNOWLEDGE-2.0 K-5 | — | Distillation sweep interval in seconds | Unset uses the built-in interval |
| `MYRMIDON_DISTILL_KEY_SECRET` | KNOWLEDGE-2.0 K-5 | — | Secret key for the distillation gateway; handle as a credential and never log its value | Unset disables authenticated gateway calls |
| `MYRMIDON_DISTILL_MAX_DURATION_SEC` | KNOWLEDGE-2.0 K-5 | — | Maximum target duration for one distillation pass, in seconds | Unset uses the built-in limit |
| `MYRMIDON_DISTILL_MAX_INPUT_TOKENS` | KNOWLEDGE-2.0 K-5 | — | Approximate input-token budget for one distillation pass | Unset uses the built-in budget |
| `MYRMIDON_DISTILL_MAX_TASKS` | KNOWLEDGE-2.0 K-5 | — | Maximum number of completed tasks read by one pass | Unset uses the built-in cap |
| `MYRMIDON_DISTILL_MODEL` | KNOWLEDGE-2.0 K-5 | — | Model identifier sent to the configured gateway | Unset uses the configured default model |
| `MYRMIDON_DISTILL_WINDOW_SEC` | KNOWLEDGE-2.0 K-5 | — | Lookback window for completed tasks, in seconds | Unset uses the built-in window |

## settings-ru

| `MYRMIDON_DISTILL_AUTO_ACCEPT` | KNOWLEDGE-2.0 K-5 | `false` | Включает автоматическое принятие подходящих предложений дистилляции знаний; по умолчанию выключено | Не задана или `false` — авто-принятие выключено |
| `MYRMIDON_DISTILL_GATEWAY_URL` | KNOWLEDGE-2.0 K-5 | — | Адрес OpenAI-совместимого шлюза для вызова модели дистилляции | Без значения используется настроенный шлюз по умолчанию |
| `MYRMIDON_DISTILL_INTERVAL_SEC` | KNOWLEDGE-2.0 K-5 | — | Интервал обхода дистилляции в секундах | Без значения используется встроенный интервал |
| `MYRMIDON_DISTILL_KEY_SECRET` | KNOWLEDGE-2.0 K-5 | — | Секретный ключ шлюза дистилляции; обращайтесь с ним как с учетными данными и никогда не записывайте его значение в лог | Без ключа аутентифицированные вызовы шлюза отключены |
| `MYRMIDON_DISTILL_MAX_DURATION_SEC` | KNOWLEDGE-2.0 K-5 | — | Целевая максимальная длительность одного прохода дистилляции в секундах | Без значения используется встроенный предел |
| `MYRMIDON_DISTILL_MAX_INPUT_TOKENS` | KNOWLEDGE-2.0 K-5 | — | Приблизительный бюджет входных токенов одного прохода | Без значения используется встроенный бюджет |
| `MYRMIDON_DISTILL_MAX_TASKS` | KNOWLEDGE-2.0 K-5 | — | Максимальное количество закрытых задач для одного прохода | Без значения используется встроенный предел |
| `MYRMIDON_DISTILL_MODEL` | KNOWLEDGE-2.0 K-5 | — | Идентификатор модели, передаваемый настроенному шлюзу | Без значения используется настроенная модель по умолчанию |
| `MYRMIDON_DISTILL_WINDOW_SEC` | KNOWLEDGE-2.0 K-5 | — | Окно поиска закрытых задач в секундах | Без значения используется встроенное окно |
