---
divergence-section: 1.6.1 — BOT-RUNTIME-TUNING, часть B: компилятор профиля
settings-section: Track 5 — operations
---

## changelog-en

### Input-token economy for bots: stale wake messages, stale tool results, unused tool schemas (CONTEXT-ECONOMY A/B, TOOL-DIET D)

- **A. Superseded wake messages.** The bot runtime (patch `16-context-economy`) sends every
  wake message of a session except the newest as a short note (run, issue, wake reason) instead of
  the whole task package. Only the per-call request copy changes; the transcript, `state.db` and
  compaction input are untouched. `HERMES_KEEP_STALE_WAKES=1` in the bot's env restores the old request
  byte for byte.
- **B. Stale tool results.** A tool result of at least 8000 characters that lies below a
  boundary (moving in steps of 8 messages, the last 8 messages are never touched) is sent as a note with the
  tool, its argument summary, the size, a short head and tail and a `ref`. The new `read_stale_tool_result`
  tool returns the original for the ref (in windows for long results). Untrusted external text is never quoted into
  a note. `HERMES_KEEP_STALE_TOOL_RESULTS=1` restores the old request and removes the tool from the
  schema; `HERMES_STALE_TOOL_MIN_CHARS`, `HERMES_STALE_TOOL_KEEP_MESSAGES`, `HERMES_STALE_TOOL_STEP`
  and `HERMES_STALE_TOOL_EXEMPT` (comma-separated tool names never replaced) tune it. The runtime logs
  `context-economy: session=… stale_wakes=… stale_tool_results=… saved_chars=…` whenever the counts change.
- **D. Unused tool schemas.** Patch `17-disabled-tools-by-name` adds `agent.disabled_tools` (single tools,
  subtracted after the toolsets), and the profile compiler writes it: the instance list
  `MYRMIDON_BOT_DISABLED_TOOLS` (default: the five `browser_vault_*` tools and `vision_analyze`,
  about 1.2k tokens per call), replaced by the card's own `adapterConfig.disabledTools` when present.
  A card with its own vision model keeps `vision_analyze`. `MYRMIDON_BOT_DISABLED_TOOLS=none` restores the
  previous `config.yaml`. A changed `config.yaml` restarts the bot container.

## changelog-ru

### Экономия входных токенов ботов: устаревшие wake-сообщения, устаревшие результаты инструментов, неиспользуемые схемы (CONTEXT-ECONOMY A/B, TOOL-DIET D)

- **A. Устаревшие wake-сообщения.** Рантайм бота (патч `16-context-economy`) отправляет каждое
  wake-сообщение сессии, кроме последнего, короткой отметкой (прогон, задача, причина побудки) вместо
  всего пакета задачи. Меняется только копия запроса на вызов; транскрипт, `state.db` и вход
  компакции не затрагиваются. `HERMES_KEEP_STALE_WAKES=1` в env бота возвращает прежний запрос байт в байт.
- **B. Устаревшие результаты инструментов.** Результат от 8000 символов, лежащий ниже границы
  (граница сдвигается шагами по 8 сообщений, последние 8 сообщений не трогаются), уходит отметкой: инструмент,
  краткие аргументы, размер, начало и конец, `ref`. Новый инструмент `read_stale_tool_result` возвращает
  оригинал по `ref` (длинный — окнами). Недоверенный внешний текст в отметку не цитируется.
  `HERMES_KEEP_STALE_TOOL_RESULTS=1` возвращает прежний запрос и убирает инструмент из схемы;
  `HERMES_STALE_TOOL_MIN_CHARS`, `HERMES_STALE_TOOL_KEEP_MESSAGES`, `HERMES_STALE_TOOL_STEP` и
  `HERMES_STALE_TOOL_EXEMPT` (имена инструментов через запятую, которые не заменяются) настраивают меру.
  Рантайм пишет в журнал `context-economy: session=… stale_wakes=… stale_tool_results=… saved_chars=…` при изменении счётчиков.
- **D. Неиспользуемые схемы инструментов.** Патч `17-disabled-tools-by-name` добавляет `agent.disabled_tools`
  (отдельные инструменты, вычитаются после наборов), компилятор профиля его пишет: список инстанса
  `MYRMIDON_BOT_DISABLED_TOOLS` (по умолчанию пять `browser_vault_*` и `vision_analyze`, около 1,2 тыс. токенов
  на вызов), его заменяет `adapterConfig.disabledTools` карточки, если задано. Карточка со своей моделью
  зрения сохраняет `vision_analyze`. `MYRMIDON_BOT_DISABLED_TOOLS=none` возвращает прежний `config.yaml`.
  Изменение `config.yaml` перезапускает контейнер бота.

## divergence

| CONTEXT-ECONOMY | Рантайм бота не пересылает в каждом вызове то, что модели уже не нужно целиком: wake-сообщения сессии кроме последнего заменяются короткой отметкой, а результаты инструментов от 8000 символов ниже сдвигаемой шагами границы (последние 8 сообщений не трогаются) — отметкой с `ref`, по которому новый инструмент `read_stale_tool_result` отдаёт оригинал. Меняется только копия запроса: транскрипт, `state.db` и вход компакции прежние. Выключатели `HERMES_KEEP_STALE_WAKES=1` и `HERMES_KEEP_STALE_TOOL_RESULTS=1` возвращают прежний запрос байт в байт | `docker/bot-runtime/patches/16-context-economy.patch`: `agent/context_economy.py` (новый), `tools/stale_result_tool.py` (новый), `agent/turn_request_assembly.py`, `agent/tool_result_classification.py`, `toolsets.py` | Замер 14.10: вход флота 1,79 млрд токенов в сутки, из них около 40% — пакеты wake и около 40% — результаты инструментов, перепосылаемые в каждом вызове | `docker/bot-runtime/tests/context_economy.py` (сборка образа) | При появлении в апстриме обрезки устаревших prompt и результатов на пути отправки с возвратом оригинала; до того — держать патч | context economy A/B |
| TOOL-DIET | Конфиг бота получает `agent.disabled_tools` — отдельные инструменты вне схемы модели: список инстанса `MYRMIDON_BOT_DISABLED_TOOLS` (по умолчанию пять `browser_vault_*` и `vision_analyze`, не вызванные ни разу за 7000 вызовов), список карточки `adapterConfig.disabledTools` его заменяет, карточка с моделью зрения сохраняет `vision_analyze`. `none` возвращает прежний `config.yaml` | `docker/bot-runtime/patches/17-disabled-tools-by-name.patch` (`model_tools.py`), `server/src/myrmidon/bot-containers/profile-compiler.ts`, `profile-input.ts` | Набор инструментов задаётся целыми наборами, а хранилище логинов браузера едет с браузером, `vision_analyze` — отдельный набор: схемы этих инструментов (около 1,2 тыс. токенов) платились в каждом вызове ролями, которые их не зовут | `docker/bot-runtime/tests/disabled_tools.py`; `profile-compiler.myrmidon.test.ts`, `profile-input.myrmidon.test.ts` (TOOL-DIET) | При появлении в апстриме списка отключённых инструментов рядом с `agent.disabled_toolsets` | context economy D |

## settings-en

| `MYRMIDON_BOT_DISABLED_TOOLS` | TOOL-DIET | `browser_vault_enter_code,browser_vault_fill,browser_vault_list,browser_vault_save_login,browser_vault_unlock,vision_analyze` | Comma-separated single tool names written to `agent.disabled_tools` in every bot's `hermes/config.yaml`, so their schemas are not sent on each model call (the tools that no measured role called in ~7000 calls over three days). The card's own `adapterConfig.disabledTools` list replaces it (an empty list keeps every tool for that bot); a card with its own vision model (`models.vision`) keeps `vision_analyze` | `none` (also `off`, `-`) restores the previous `config.yaml`. Read on every profile build; a change restarts the affected bot containers. A name that is not a tool name is dropped with a profile warning |
| `HERMES_KEEP_STALE_WAKES` | CONTEXT-ECONOMY A | unset (measure on) | Bot-runtime switch (set in a bot's env, not a board setting): `1` sends every wake message in full again | Unset / any other value keeps the measure on. Read on every model call; the container env change restarts the bot |
| `HERMES_KEEP_STALE_TOOL_RESULTS` | CONTEXT-ECONOMY B | unset (measure on) | Bot-runtime switch: `1` sends every tool result in full again and removes `read_stale_tool_result` from the tool schema. Tuning: `HERMES_STALE_TOOL_MIN_CHARS` (8000), `HERMES_STALE_TOOL_KEEP_MESSAGES` (8), `HERMES_STALE_TOOL_STEP` (8), `HERMES_STALE_TOOL_EXEMPT` (comma-separated tool names never replaced) | Unset / any other value keeps the measure on |

## settings-ru

| `MYRMIDON_BOT_DISABLED_TOOLS` | TOOL-DIET | `browser_vault_enter_code,browser_vault_fill,browser_vault_list,browser_vault_save_login,browser_vault_unlock,vision_analyze` | Имена отдельных инструментов через запятую, которые пишутся в `agent.disabled_tools` в `hermes/config.yaml` каждого бота: их схемы не отправляются в каждом вызове модели (инструменты, которые ни одна измеренная роль не вызвала за ~7000 вызовов за трое суток). Свой список карточки `adapterConfig.disabledTools` заменяет этот (пустой список оставляет боту все инструменты); карточка со своей моделью зрения (`models.vision`) сохраняет `vision_analyze` | `none` (также `off`, `-`) возвращает прежний `config.yaml`. Читается при каждой сборке профиля; изменение перезапускает затронутые контейнеры ботов. Имя, не являющееся именем инструмента, отбрасывается с предупреждением профиля |
| `HERMES_KEEP_STALE_WAKES` | CONTEXT-ECONOMY A | не задано (мера включена) | Выключатель рантайма бота (в env бота, не настройка доски): `1` снова отправляет каждое wake-сообщение целиком | Не задано или другое значение — мера включена. Читается при каждом вызове модели; смена env контейнера перезапускает бота |
| `HERMES_KEEP_STALE_TOOL_RESULTS` | CONTEXT-ECONOMY B | не задано (мера включена) | Выключатель рантайма бота: `1` снова отправляет каждый результат инструмента целиком и убирает `read_stale_tool_result` из схемы. Настройка: `HERMES_STALE_TOOL_MIN_CHARS` (8000), `HERMES_STALE_TOOL_KEEP_MESSAGES` (8), `HERMES_STALE_TOOL_STEP` (8), `HERMES_STALE_TOOL_EXEMPT` (имена инструментов через запятую, которые не заменяются) | Не задано или другое значение — мера включена |
