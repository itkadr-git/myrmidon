## changelog-en

### Call-limit continuations get their own ceiling, and a final guard stop wakes the manager (RUN-GUARD-CONTINUE, RUN-GUARD-ESCALATE)

- A run the run guard stopped at `model_call_limit` after it made changes (`writeCalls > 0`) is continued, as
  before, in a follow-up run. Those continuations no longer spend the max-turn ceiling
  (`heartbeat.maxTurnContinuation.maxAttempts`, default 2): three runs in a row of 150 calls and 16–27 writes
  each used to end with the task in `blocked` ("no automatic retry"). They have their own ceiling,
  `heartbeat.runGuardContinuation.maxAttempts` in the agent runtime config: default 10, at most 20, counted
  along the chain of call-limit continuations only (the count travels in the run context as
  `runGuardContinuationAttempts`). A max-turn stop later in the same chain still has its whole ceiling.
  `heartbeat.runGuardContinuation.enabled: false` or `maxAttempts: 0` makes the call-limit stop final again;
  `heartbeat.maxTurnContinuation.enabled: false` still does too.
- The stop is final, and the task goes to `blocked` with the "new input is needed" comment, when the last run
  made no change (`writeCalls` 0), when the own ceiling is spent, or for any other guard reason.
- A final guard stop now wakes the assignee's manager (`agents.reports_to`; without a usable one, the agent
  named `adm`; without that, nobody) with the wake reason `run_guard_stop_needs_input`. The wake carries the
  issue id and the stop text in its payload, leaves the assignee and the status as the escalation set them,
  and is sent at most once per issue per 30 minutes (checked against the wake requests the board keeps). Both
  places that block a guard-stopped task send it: the stop handling in `heartbeat.ts` and the stranded-issue
  sweep. The bot skill (`skills/myrmidon/references/heartbeat-procedure.md`) tells the manager what to do: read
  the last run, put the point of the fix into the description or split the task into 1–2 hour subtasks, and
  return it to `todo` in one `PATCH`. The queued-run staleness check (`modules/run-dispatch`) lets this wake
  start although the manager is not the assignee, bound to the exact automation source and wake reason; a
  terminal issue still cancels it.

## changelog-ru

### Продолжения после лимита вызовов получили свой потолок, а окончательная остановка защитой будит руководителя (RUN-GUARD-CONTINUE, RUN-GUARD-ESCALATE)

- Прогон, остановленный защитой на `model_call_limit` после изменений (`writeCalls > 0`), по-прежнему
  продолжается в следующем прогоне. Но такие продолжения больше не расходуют потолок продолжений по числу
  ходов (`heartbeat.maxTurnContinuation.maxAttempts`, по умолчанию 2): три прогона подряд по 150 вызовов и
  16–27 записей раньше заканчивались блоком задачи («автоповтора не будет»). У них свой потолок,
  `heartbeat.runGuardContinuation.maxAttempts` в runtime-конфиге агента: по умолчанию 10, не больше 20,
  считается только по цепочке продолжений после лимита вызовов (счётчик едет в контексте прогона как
  `runGuardContinuationAttempts`). Остановка по числу ходов дальше в той же цепочке по-прежнему получает свой
  потолок целиком. `heartbeat.runGuardContinuation.enabled: false` или `maxAttempts: 0` снова делает остановку
  по лимиту вызовов окончательной; `heartbeat.maxTurnContinuation.enabled: false` тоже.
- Остановка окончательная, и задача уходит в `blocked` с комментарием «нужна новая вводная», когда последний
  прогон ничего не менял (`writeCalls` 0), когда исчерпан собственный потолок и при любой другой причине защиты.
- Окончательная остановка защитой теперь будит руководителя исполнителя (`agents.reports_to`; если подходящего
  нет, то агента с именем `adm`; если нет и его, то никого) с причиной пробуждения `run_guard_stop_needs_input`.
  В нагрузке пробуждения — id задачи и текст остановки; исполнитель и статус остаются такими, какими их
  оставила эскалация; на одну задачу не чаще одного раза в 30 минут (проверка по запросам пробуждения,
  которые доска и так хранит). Пробуждение шлют оба места, где блокируется задача с остановленным защитой
  прогоном: обработка остановки в `heartbeat.ts` и сторож застрявших задач. Навык ботов
  (`skills/myrmidon/references/heartbeat-procedure.md`) говорит руководителю, что делать: прочитать последний
  прогон, дописать в описание точку правки или разбить задачу на подзадачи по 1–2 часа и вернуть её в `todo`
  одним `PATCH`. Проверка устаревания очереди (`modules/run-dispatch`) пропускает это пробуждение, хотя
  руководитель не исполнитель, строго по источнику автоматики и причине пробуждения; закрытая задача по-прежнему
  его отменяет.
