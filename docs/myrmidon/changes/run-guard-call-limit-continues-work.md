## changelog-en

### A call-limit stop of a run that made changes continues the work instead of blocking the task (RUN-GUARD-CONTINUE)

- `model_call_limit` (150 model calls) also trips on productive work: runs that patched and wrote files
  were stopped and their tasks went to `blocked` with "give the assignee a new input". The run guard now
  counts the calls that change something (`writeCalls` in `RunGuard.stats()`, stored with the run next to
  `runGuardStats`): every tool call that is not read-only, the same classification as the exploration check.
- When a run stops with `model_call_limit` and `writeCalls > 0`, the task is not blocked and no "new input"
  comment is written. The work continues in a follow-up run, the way it continues after a max-turn stop (retry
  reason `max_turns_continuation`), within the same ceiling (`heartbeat.maxTurnContinuation.maxAttempts`,
  default 2, counted along the chain of follow-ups). When the ceiling is spent, the continuation policy is
  off, or the task is no longer `in_progress` with the same assignee, the stop is final as before: `blocked`
  plus the comment.
- Unchanged: `model_call_limit` with no changing call, and every other reason (`no_progress_exploration`,
  `repeated_tool_call`, `tool_retry_loop`, `idle_timeout`) stay final: no retry, `blocked`, comment. Adapters
  that do not feed tool starts to the guard report `writeCalls: 0` and keep the old behaviour.

## changelog-ru

### Остановка по лимиту вызовов у прогона, который вносил изменения, продолжает работу, а не блокирует задачу (RUN-GUARD-CONTINUE)

- `model_call_limit` (150 вызовов модели) срабатывает и на продуктивной работе: прогоны, которые правили и
  писали файлы, останавливались, а их задачи уходили в `blocked` с «дать исполнителю новую вводную». Защита
  прогона теперь считает вызовы, которые что-то меняют (`writeCalls` в `RunGuard.stats()`, сохраняется с
  прогоном рядом с `runGuardStats`): любой вызов инструмента, не являющийся чтением, по той же классификации,
  что и проверка чтения без записи.
- Когда прогон остановлен по `model_call_limit` и `writeCalls > 0`, задача не блокируется и комментарий
  «нужна новая вводная» не пишется. Работа продолжается в следующем прогоне так же, как после остановки по
  числу ходов (причина повтора `max_turns_continuation`), в рамках того же потолка
  (`heartbeat.maxTurnContinuation.maxAttempts`, по умолчанию 2, считается по цепочке продолжений). Если
  потолок исчерпан, политика продолжения выключена или задача уже не в `in_progress` у того же исполнителя,
  остановка окончательная, как раньше: `blocked` и комментарий.
- Без изменений: `model_call_limit` без единого вызова с изменениями и все остальные причины
  (`no_progress_exploration`, `repeated_tool_call`, `tool_retry_loop`, `idle_timeout`) остаются окончательными:
  без повтора, `blocked`, комментарий. Адаптеры, которые не передают защите начала вызовов инструментов,
  отдают `writeCalls: 0` и ведут себя как раньше.
