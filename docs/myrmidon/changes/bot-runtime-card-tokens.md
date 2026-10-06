## changelog-en

### Compression threshold in tokens comes from the agent card; the fleet compacts at 100 000 (BOT-RUNTIME-TUNING A)

- A bot profile now carries `compression.threshold_tokens: 100000` by default, so a
  long session compacts at that count instead of at half the model's window (for
  `dashscope-glm-5.3` that was ~255k tokens and multi-minute compactions).
- The agent card gained a **Compression threshold (tokens)** field
  (`adapterConfig.models.compressionThresholdTokens`): one agent can be tuned
  without touching the instance. Empty keeps the company default.
- `MYRMIDON_BOT_COMPRESSION_THRESHOLD_TOKENS` is now an override of that company
  default instead of an on/off switch, and an explicit `0` turns the cap off
  (Hermes's own 256 000 applies). `model.context_length` and its own card field
  are unchanged.

## changelog-ru

### Порог компресса в токенах задаётся карточкой агента, флот сжимается на 100 000 (BOT-RUNTIME-TUNING A)

- Профиль бота теперь по умолчанию несёт `compression.threshold_tokens: 100000`:
  длинная сессия сжимается на этом числе, а не на половине окна модели (у
  `dashscope-glm-5.3` это было ~255k токенов и многоминутные компакции).
- На карточке агента появилось поле **Compression threshold (tokens)**
  (`adapterConfig.models.compressionThresholdTokens`): одного агента можно
  настроить, не трогая инстанс. Пустое поле — дефолт компании.
- `MYRMIDON_BOT_COMPRESSION_THRESHOLD_TOKENS` теперь переопределяет этот дефолт
  компании, а не включает/выключает запись; явный `0` выключает потолок
  (действует собственный порог Hermes, 256 000). `model.context_length` и его
  поле на карточке не изменились.

## divergence-new

<!-- after: 1.6.1 — BOT-RUNTIME-TUNING, часть B: компилятор профиля -->
### 1.6.5 — BOT-RUNTIME-TUNING, часть A: порог компресса и окно модели из карточки агента

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| BOT-RUNTIME-TUNING-A | Тот же порог компресса и окно модели, но с карточки агента. Новое поле карточки `models.compressionThresholdTokens` (абсолютный порог компакции в токенах) пишется в `compression.threshold_tokens` и сильнее значения инстанса; пустое поле карточки — дефолт компании. Дефолт компании для порога — 100 000 токенов: при незаданной `MYRMIDON_BOT_COMPRESSION_THRESHOLD_TOKENS` (или нечитаемом значении — с предупреждением в профиле) инстанс отдаёт 100 000, поэтому карточка без новых полей компилируется как раньше, но Hermes уже не растягивает сессию до половины большого окна; явный `0` в переменной выключает потолок совсем (пишется как раньше — ничего). Явное значение карточки вне диапазона 10 000–2 000 000 отбрасывается с предупреждением, и дефолт инстанса на его место НЕ подставляется — компилятор не заменяет названное карточкой число другим (то же правило, что у `models.contextLength`). Приоритет: карточка > значение инстанса из настроек > дефолт компании. Сам компилятор собственного дефолта по-прежнему не добавляет: дефолт приходит из `readBotProfileSettings`, поэтому вызов компилятора без instanceDefaults компилируется байт-в-байт как прежде | Наши файлы `server/src/myrmidon/bot-containers/profile-input.ts` (дефолт компании, разбор поля карточки, приоритет слияния), `server/src/myrmidon/bot-containers/profile-compiler.ts` (карточка сильнее дефолта, валидация диапазона, происхождение значения в предупреждении), `ui/src/components/myrmidon/AgentCardModelsFields.tsx` (поле карточки, общий ввод токенов с окном контекста); маркеры `myrmidon(BOT-RUNTIME-TUNING-A)`; вендор не тронут | Длинные сессии ботов на `dashscope-glm-5.3` росли до ~255k токенов с многоминутными компакциями: Hermes сжимает на меньшем из долевого порога (0.5) и `compression.threshold_tokens`, а окно модели он берёт захардкоженным (1.31M). Часть B дала механизм и настройку инстанса, но с карточки порог задать было нельзя, а без настройки инстанса не писалось ничего — то есть дефолта 100k, названного задачей, не существовало | `server/src/myrmidon/bot-containers/profile-compiler.myrmidon.test.ts` (блок `BOT-RUNTIME-TUNING-A`: карточка без инстанса, карточка сильнее инстанса, долевые настройки рядом с порогом карточки, drop вне диапазона с происхождением в предупреждении, отсутствие блока без обоих источников), `profile-input.myrmidon.test.ts` (дефолт компании при незаданной/пустой/нечитаемой переменной, явный `0` = выключено, перенос поля карточки в `config.yaml`, нечитаемое поле карточки → дефолт компании), `profile-compile.myrmidon.test.ts` (полный цикл: дефолт 100k, `0` = нет строки, порог карточки сильнее), `ui/src/components/myrmidon/AgentCardModelsFields.myrmidon.test.tsx` (поле: чтение/запись, placeholder с дефолтом, ошибка диапазона, очистка = дефолт, сжатие) | Никогда, наше поведение; уходит вместе со всей серией G (компилятор профиля контейнеров). При снятии: убрать блоки `myrmidon(BOT-RUNTIME-TUNING-A)`, `BOT_DEFAULT_COMPRESSION_THRESHOLD_TOKENS`, поле `models.compressionThresholdTokens` из разбора карточки и из UI, вернуть строку SETTINGS про незаданную переменную | (этот PR) |

## settings-en-replace

| `MYRMIDON_BOT_COMPRESSION_THRESHOLD_TOKENS` | BOT-RUNTIME-TUNING-B (the setting), BOT-RUNTIME-TUNING-A (the default and the card field) | `100000` | Absolute token cap for context compression, written to `compression.threshold_tokens` in every bot's `hermes/config.yaml`: Hermes compresses at the LOWER of the ratio threshold and this count, so on a large-window model a session no longer grows to half the window before compacting. It is an override of the company default now: unset (or unusable) means `100000`, and the agent card's own **Compression threshold (tokens)** field (`adapterConfig.models.compressionThresholdTokens`) wins over it. A card's value outside 10 000–2 000 000 is dropped with a profile warning and the instance value is NOT substituted for it | An explicit `0` — no cap: nothing is written and Hermes's own 256 000 applies. A non-integer value is reported and the company default `100000` is used. Read on every profile build; a change restarts bot containers (part of `config.yaml`) |

## settings-ru-replace

| `MYRMIDON_BOT_COMPRESSION_THRESHOLD_TOKENS` | BOT-RUNTIME-TUNING-B (настройка), BOT-RUNTIME-TUNING-A (дефолт и поле карточки) | `100000` | Абсолютный порог компакции контекста в токенах, пишется в `compression.threshold_tokens` в `hermes/config.yaml` каждого бота: Hermes сжимает на МЕНЬШЕМ из долевого порога и этого числа, поэтому на модели с большим окном сессия больше не растёт до половины окна перед сжатием. Теперь это переопределение дефолта компании: не задана (или значение нечитаемо) — берётся `100000`, а поле карточки агента **Compression threshold (tokens)** (`adapterConfig.models.compressionThresholdTokens`) сильнее его. Значение карточки вне 10 000–2 000 000 отбрасывается с предупреждением в профиле, значение инстанса на его место НЕ подставляется | Явный `0` — потолка нет: не пишется ничего, действует собственный порог Hermes, 256 000. Нецелое значение сообщается, и берётся дефолт компании `100000`. Читается при каждой сборке профиля; изменение перезапускает контейнеры ботов (часть `config.yaml`) |