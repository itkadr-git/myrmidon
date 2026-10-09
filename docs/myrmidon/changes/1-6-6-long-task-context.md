---
divergence-section: Трек 2 — ядро побудок и прогонов
settings-section: Track 2 — wake and run core
---

## changelog-en

### 1.6.6 LONG-TASK-CONTEXT: an ever-running task no longer kills its run on context compression (OPE-6816)

- The runtime's compression timeouts (`Context compression timed out:
  approximately 214 298 / 378 739 tokens`, `Context compression timed out
  without reducing this conversation`) now match the context-window signatures:
  such a run drops the task session and leaves the agent idle, instead of
  landing the agent in `error` until a human resets the session by hand.
- Live settings `instance_settings.general.longTaskContext` (`enabled`,
  `resetPct`, `fallbackWindowTokens`, `historyChars`): a task session already at
  `resetPct` (default 70%) of the model window is dropped BEFORE the next run
  resumes it — compression up to the threshold, not after it — and the reset is
  named in the run's own context.
- The launch payload's task history is bounded by volume as well as by count:
  `MYRMIDON_CONTINUATION_HISTORY_CHARS` (24k) of message text in total and
  `MYRMIDON_CONTINUATION_MESSAGE_MAX_CHARS` (8k) per entry; entries that do not
  fit are dropped and referenced through the issue API instead of travelling
  with every run of the task.
- Guide: [guides/long-task-context.md](../guides/long-task-context.md).

## changelog-ru

### 1.6.6 LONG-TASK-CONTEXT: бессрочная задача больше не роняет прогон на сжатии контекста (OPE-6816)

- Таймауты сжатия контекста (`Context compression timed out: approximately
  214 298 / 378 739 tokens`, `Context compression timed out without reducing
  this conversation`) теперь попадают в подписи контекстного окна: такой прогон
  сбрасывает сессию задачи и оставляет агента в покое, а не переводит его в
  `error` до ручного сброса сессии человеком.
- Живые настройки `instance_settings.general.longTaskContext` (`enabled`,
  `resetPct`, `fallbackWindowTokens`, `historyChars`): сессия задачи, уже
  дошедшая до `resetPct` (умолчание — 70 %) окна модели, сбрасывается ДО того,
  как следующий прогон её продолжит, — сжатие до порога, а не после; сброс
  назван в контексте самого прогона.
- История задачи в payload побудки ограничена не только по числу записей, но и
  по объёму: `MYRMIDON_CONTINUATION_HISTORY_CHARS` (24 тыс.) текста сообщений
  всего и `MYRMIDON_CONTINUATION_MESSAGE_MAX_CHARS` (8 тыс.) на запись; не
  поместившиеся записи отбрасываются и остаются доступны по API задачи, а не
  едут в каждом прогоне.
- Руководство: [guides/long-task-context.ru.md](../guides/long-task-context.ru.md).

## divergence

| LONG-TASK-CONTEXT | Прогон по задаче с бессрочно растущей историей не падает на сжатии контекста. Три части: (1) подписи таймаутов сжатия (`context compression timed out`, `compression timed out without reducing this conversation`) добавлены в `CONTEXT_WINDOW_ERROR_SIGNATURES`, поэтому такой прогон идёт существующим путём сброса сессии и агент остаётся `idle`, а не уходит в `error`; (2) гард `long-task-context` перед продолжением сессии задачи считает долю окна модели по последнему прогону этой же задачи и сбрасывает сессию ЗАРАНЕЕ (умолчание — 70 % окна), называя сброс в предупреждениях прогона; (3) `limitExecutionContinuationHistory` ограничивает историю в payload по объёму (общий бюджет символов + предел на одну запись), старые записи остаются доступны по API задачи. Настройки — `instance_settings.general.longTaskContext` (`enabled`, `resetPct`, `fallbackWindowTokens`, `historyChars`), читаются на каждый запуск, переопределяются переменными `MYRMIDON_LONG_TASK_CONTEXT_*` с записью источника (env/stored/default). Панель настроек и маршрут API в эту часть не входят | Новые файлы: `packages/shared/src/myrmidon-long-task-context.ts`, `server/src/myrmidon/long-task-context/{domain,settings,pressure,index}.ts`, `server/src/myrmidon/long-task-context/long-task-context.myrmidon.test.ts`. Изменены с маркером `myrmidon(1.6.6 LONG-TASK-CONTEXT)`: `packages/shared/src/index.ts`, `server/src/myrmidon/continuation-history-limit.ts`, `server/src/services/heartbeat.ts` | 09.10.2026 в проде: adm-dev-release, OPE-3931 (165 комментариев, ~120 тыс. символов) — прогоны 19:51 и 21:25 упали «Context compression timed out … approximately 214 298 / 378 739 tokens», статус агента `error`, задача не продолжается без ручного сброса сессии; bbq-smm, OPE-6298 — то же в 19:04. Вендорского аналога предпорогового сброса нет | `server/src/myrmidon/long-task-context/long-task-context.myrmidon.test.ts` (обе продовые подписи и обычная ошибка; порог от окна модели, граница, выключенный гард, неизвестное окно, отсутствие измерения; источник настроек env/stored/default и нечитаемое переопределение), `server/src/myrmidon/continuation-history-limit.myrmidon.test.ts` (бюджет объёма, приоритет закреплённых записей, предел на одну запись, синтетическая задача на 165 комментариев), `server/src/__tests__/context-window-error.test.ts` (продовые строки таймаута сжатия) | Никогда, наше поведение. Снятие: удалить перечисленные новые файлы, строки с маркером `myrmidon(1.6.6 LONG-TASK-CONTEXT)` в вендорских файлах, строки из SETTINGS и руководство | (этот PR) |

## settings-en

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_CONTINUATION_HISTORY_CHARS` | LONG-TASK-CONTEXT | `24000` | Total character budget of the message text a launch payload carries: the newest entries that fit travel, the rest are dropped and named as readable through the issue API (`GET /api/issues/:id/comments`). Bounds a task whose thread has no end date — before this the payload grew with the thread on every run | `0` — no volume bound (the count limit alone applies). Unset, non-numeric or negative — the default |
| `MYRMIDON_CONTINUATION_MESSAGE_MAX_CHARS` | LONG-TASK-CONTEXT | `8000` | Per-entry cap of one history message body: a single 50k-character comment no longer travels whole, its tail is replaced by a marker naming where the full text stays | `0` — no per-entry cap. Unset, non-numeric or negative — the default |
| `MYRMIDON_LONG_TASK_CONTEXT_ENABLED` | LONG-TASK-CONTEXT | `1` (on) | Master switch of the pre-threshold session reset: off — the pressure is still measured and reported in the run's context, but a task session is never dropped early | `0`/`false`/`off`/`no` — disable. Unset or unrecognized — enabled: a typo does not silently extinguish the fix |
| `MYRMIDON_LONG_TASK_CONTEXT_RESET_PCT` | LONG-TASK-CONTEXT | `70` | Share of the model window at which the task session is dropped BEFORE the next run resumes it (compression up to the threshold, not after it) | Whole number 1–99; unparseable — the default, or the stored value when the row is usable |
| `MYRMIDON_LONG_TASK_CONTEXT_FALLBACK_WINDOW_TOKENS` | LONG-TASK-CONTEXT | `200000` | The window the percentage counts against when the agent's model has no known `maxInputTokens` | Whole number 1000–100000000; unparseable — the default |
| `MYRMIDON_LONG_TASK_CONTEXT_HISTORY_CHARS` | LONG-TASK-CONTEXT | `24000` | The `historyChars` field of the stored settings row, reported to the operator; the runtime bound itself is read from `MYRMIDON_CONTINUATION_HISTORY_CHARS` (same default) | Whole number 2000–1000000; unparseable — the default |

## settings-ru

| Переменная | Функция | По умолчанию | Что делает | Как выключить / особое |
|---|---|---|---|---|
| `MYRMIDON_CONTINUATION_HISTORY_CHARS` | LONG-TASK-CONTEXT | `24000` | Общий бюджет символов текста сообщений, который везёт payload побудки: помещаются новейшие записи, остальные отбрасываются и названы доступными по API задачи (`GET /api/issues/:id/comments`). Ограничивает задачу, у которой нет конца, — до этого payload рос вместе с историей в каждом прогоне | `0` — объём не ограничен (действует только предел по числу записей). Не задана, не число или отрицательное — умолчание |
| `MYRMIDON_CONTINUATION_MESSAGE_MAX_CHARS` | LONG-TASK-CONTEXT | `8000` | Предел на тело одной записи истории: комментарий на 50 тыс. символов больше не едет целиком, хвост заменяется пометкой, где остаётся полный текст | `0` — предела на запись нет. Не задана, не число или отрицательное — умолчание |
| `MYRMIDON_LONG_TASK_CONTEXT_ENABLED` | LONG-TASK-CONTEXT | `1` (вкл) | Выключатель предпорогового сброса сессии: выключено — давление всё равно измеряется и попадает в контекст прогона, но сессия задачи заранее не сбрасывается | `0`/`false`/`off`/`no` — выключить. Не задано или нераспознанное — включено: опечатка не гасит починку молча |
| `MYRMIDON_LONG_TASK_CONTEXT_RESET_PCT` | LONG-TASK-CONTEXT | `70` | Доля окна модели, на которой сессия задачи сбрасывается ДО того, как следующий прогон её продолжит (сжатие до порога, а не после) | Целое 1–99; нечитаемое — умолчание (или сохранённое значение, если строка настроек пригодна) |
| `MYRMIDON_LONG_TASK_CONTEXT_FALLBACK_WINDOW_TOKENS` | LONG-TASK-CONTEXT | `200000` | Окно, от которого считается доля, когда у модели агента нет известного `maxInputTokens` | Целое 1000–100000000; нечитаемое — умолчание |
| `MYRMIDON_LONG_TASK_CONTEXT_HISTORY_CHARS` | LONG-TASK-CONTEXT | `24000` | Поле `historyChars` сохранённой строки настроек, показывается оператору; сам предел во время прогона читается из `MYRMIDON_CONTINUATION_HISTORY_CHARS` (то же умолчание) | Целое 2000–1000000; нечитаемое — умолчание |