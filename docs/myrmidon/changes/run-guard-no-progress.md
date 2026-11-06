## changelog-en

### Run guard stops read-only loops and repeated calls; no automatic retry after a guard stop (RUN-GUARD-LOOPS)

- The run guard has two new stop reasons. `no_progress_exploration`: 40 consecutive read-only
  tool calls (`search_files`, `read_file`, `skill_view`, `read_stale_tool_result`, and terminal
  commands made only of `sed`/`grep`/`rg`/`cat`/`ls`/`find`/`head`/`tail`/`wc`/`git log|show|diff|status`)
  with no write in between. `repeated_tool_call`: the same read-only call (same tool, same argument)
  for the 3rd time since the last write. Any other tool call, any other terminal command and any
  redirection into a file counts as a write and resets both counters. The hermes gateway adapter
  feeds the guard from `tool.started`; other adapters are unchanged.
- Both limits are configurable like the other guard limits (agent card `runGuard`, team liveness
  `runGuard`, environment) and `0` switches the check off.
- A run stopped by the guard (any of the five reasons) is no longer retried automatically. The
  five reasons are permanent failures in the run retry taxonomy, the bounded retry scheduler and the
  stranded-recovery enqueue refuse such a run, and when the run ends the assignee's issue goes to
  `blocked` with a comment that says why the run was stopped and that a new input is needed.
  Maintenance interruptions and transport failures keep their retry paths.

## changelog-ru

### Защита прогона останавливает циклы чтения и повторы вызовов; после остановки защитой автоповтора нет (RUN-GUARD-LOOPS)

- У защиты прогона две новые причины остановки. `no_progress_exploration`: 40 подряд вызовов
  инструментов только на чтение (`search_files`, `read_file`, `skill_view`, `read_stale_tool_result`
  и команды терминала только из `sed`/`grep`/`rg`/`cat`/`ls`/`find`/`head`/`tail`/`wc`/`git log|show|diff|status`)
  без записи между ними. `repeated_tool_call`: один и тот же вызов на чтение (тот же инструмент,
  тот же аргумент) в третий раз после последней записи. Любой другой вызов, любая другая команда
  терминала и любое перенаправление в файл считаются записью и сбрасывают оба счётчика. Защиту
  питает адаптер hermes gateway по событию `tool.started`; остальные адаптеры не менялись.
- Оба предела настраиваются так же, как остальные пределы защиты (карточка агента `runGuard`,
  `runGuard` живости команды, окружение); `0` выключает проверку.
- Прогон, остановленный защитой (любая из пяти причин), больше не повторяется автоматически. Пять
  причин — постоянные сбои в таксономии повторов, ограниченный планировщик повторов и постановка
  восстановления застрявшей задачи такой прогон не берут, а когда прогон завершён, задача
  исполнителя переходит в `blocked` с комментарием: почему остановлен и что нужна новая вводная.
  Прерывания обслуживанием и сбои связи идут своими путями повтора.

## divergence-new

### 1.7 — RUN-GUARD-LOOPS: остановка циклов чтения и повторов, без автоповтора после остановки защитой

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.7-RUN-GUARD-LOOPS | Защита прогона получила причины `no_progress_exploration` (40 подряд вызовов на чтение без записи) и `repeated_tool_call` (один и тот же вызов на чтение в 3-й раз после последней записи); счётчики питает `tool.started` адаптера hermes gateway (`RunGuard.toolStarted`), разбор вызова (чтение или запись, команды терминала) — в новом `myrmidon-run-guard-tools.ts`. Прогон, остановленный защитой, не повторяется: пять причин внесены в `PERMANENT_RUN_FAILURE_ERROR_CODES`, `scheduleBoundedRetryForRun` и `enqueueStrandedIssueRecovery` отказывают такому прогону, а при завершении прогона задача исполнителя уходит в `blocked` через `escalateStrandedAssignedIssue` с комментарием (`server/src/myrmidon/run-guard-stop.ts`) | Изменены `packages/adapter-utils/src/{run-guard,index}.ts`, `packages/adapters/hermes/src/gateway/server/execute.ts`, `server/src/services/{heartbeat,heartbeat-stop-metadata,legacy-execution-recovery}.ts`, `server/src/services/recovery/service.ts`, `server/src/myrmidon/run-retry-policy/classification.ts`; новые `packages/adapter-utils/src/myrmidon-run-guard-tools.ts`, `server/src/myrmidon/run-guard-stop.ts`; `doc/RUN-GUARD-ADAPTER-COVERAGE.md` | Прогоны упирались в лимит вызовов модели или зацикливались на чтении (поиск и чтение файлов без записи) и после остановки повторялись автоматически, снова сжигая весь контекст | `packages/adapter-utils/src/{run-guard,myrmidon-run-guard-tools}.myrmidon.test.ts`, `server/src/myrmidon/run-guard-stop.myrmidon.test.ts`, `server/src/services/run-guard-loops.myrmidon.test.ts`, `server/src/__tests__/run-guard-no-retry.myrmidon.test.ts`, `server/src/services/legacy-execution-recovery.test.ts` | Вместе с защитой прогона: при замене её механизмом на стороне шлюза агента | — |

## settings-en-new

### 1.7 — RUN-GUARD-LOOPS: read-only exploration and repeated-call stops

Both limits can also be set per agent (`adapterConfig.runGuard.noProgressLimit` / `repeatedToolCallLimit`) or for the team (`runGuard` of the team liveness settings); the agent card wins over the team settings, which win over the environment.

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_RUN_GUARD_NO_PROGRESS_LIMIT` | RUN-GUARD-LOOPS | `40` | Number of consecutive read-only tool calls (no write in between) after which the run guard stops the run with `no_progress_exploration`. | `0` switches the check off. A non-numeric or negative value is ignored (the default applies). |
| `MYRMIDON_RUN_GUARD_REPEATED_TOOL_CALL_LIMIT` | RUN-GUARD-LOOPS | `3` | The run guard stops the run with `repeated_tool_call` when the same read-only call (same tool, same argument) is seen this many times since the last write. | `0` switches the check off. The hermes gateway reports only a short preview of the primary argument, so calls that differ only in arguments the preview does not show look identical; a call with an empty preview is never counted; raise the limit for an agent that repeats such calls on purpose. |

## settings-ru-new

### 1.7 — RUN-GUARD-LOOPS: остановка по чтению без записи и повторам вызовов

Оба предела задаются и на агента (`adapterConfig.runGuard.noProgressLimit` / `repeatedToolCallLimit`), и на команду (`runGuard` настроек живости команды); карточка агента важнее настроек команды, они важнее окружения.

| Переменная | Функция | По умолчанию | Что делает | Как отключить / особенности |
|---|---|---|---|---|
| `MYRMIDON_RUN_GUARD_NO_PROGRESS_LIMIT` | RUN-GUARD-LOOPS | `40` | Сколько вызовов инструментов подряд только на чтение (без записи между ними) допускается, прежде чем защита прогона остановит его с причиной `no_progress_exploration`. | `0` выключает проверку. Нечисловое или отрицательное значение игнорируется (действует умолчание). |
| `MYRMIDON_RUN_GUARD_REPEATED_TOOL_CALL_LIMIT` | RUN-GUARD-LOOPS | `3` | Защита останавливает прогон с причиной `repeated_tool_call`, когда один и тот же вызов на чтение (тот же инструмент, тот же аргумент) встретился столько раз после последней записи. | `0` выключает проверку. Hermes gateway отдаёт лишь короткий предпросмотр главного аргумента, поэтому вызовы, отличающиеся только невидимыми в нём аргументами, выглядят одинаково; вызов с пустым предпросмотром не считается никогда; для агента, который так повторяет вызовы намеренно, предел стоит поднять. |
