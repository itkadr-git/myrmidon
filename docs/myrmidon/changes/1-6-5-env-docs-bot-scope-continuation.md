---
settings-section: Track 5 — operations
---

## settings-en

| `MYRMIDON_BOT_SCOPE_SUBDIR` | BOT-DISK-F | unset (no scope) | Name of the bot's subdirectory inside the shared scope instance (the same name the driver passes as `MYRMIDON_BOT_SCOPE_SUBDIR`). The bot sees only its own instance's directory: a second instance is a different directory and never mounted | Unset — no scope isolation (the bot runs without a scope subdirectory) |
| `MYRMIDON_CONTINUATION_MESSAGE_CHARS` | DB-CARE DBC-3 | `32000` | Character budget of `messages` in the continuation context; `0` disables the budget | Non-numeric or negative — the default |
| `MYRMIDON_CONTINUATION_MESSAGE_BODY_CHARS` | DB-CARE DBC-3 | `8000` | Per-body budget used once the total budget is exceeded | Non-numeric or negative — the default |

## settings-ru

| `MYRMIDON_BOT_SCOPE_SUBDIR` | BOT-DISK-F | unset (нет скоупа) | Имя подкаталога бота внутри общего скоуп-инстанса (то же имя, что драйвер передаёт как `MYRMIDON_BOT_SCOPE_SUBDIR`). Бот видит только каталог своего инстанса: второй инстанс — другой каталог и никогда не монтируется | Не задано — нет скоуп-изоляции (бот работает без подкаталога скоупа) |
| `MYRMIDON_CONTINUATION_MESSAGE_CHARS` | DB-CARE DBC-3 | `32000` | Символьный бюджет `messages` в контексте продолжения; `0` отключает бюджет | Нечисловое или отрицательное — умолчание |
| `MYRMIDON_CONTINUATION_MESSAGE_BODY_CHARS` | DB-CARE DBC-3 | `8000` | Бюджет на одно тело сообщения, когда общий бюджет исчерпан | Нечисловое или отрицательное — умолчание |
