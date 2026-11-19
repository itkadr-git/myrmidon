## changelog-en

### A queued assignment run whose task was closed before it started is cancelled cleanly instead of failing setup (RUN-SETUP-STALE-TASK)

- On 14.11 (candidate 1.6.9-rc.2) a run queued by `issue_assigned` waited for the agent's slot while the task was closed
  and its PR merged. At start it failed with `setup_failed` / `continuation_task_ownership_changed` and an error-level log
  line; 17 such failures in 7 days. The claim-time staleness check let it through because the assignment wake carries the
  hand-off comment, and any wake with a comment bypassed the terminal-status check.
- The comment bypass no longer applies to `issue_assigned` wakes: such a run on a `done`/`cancelled` task is cancelled at
  claim with `issue_terminal_status` (info log, no `failed`). Comment wakes, resume intents and pending-card addressees
  behave as before; genuine setup failures stay `failed` with an error log.

## changelog-ru

### Прогон назначения из очереди, чья задача закрыта до старта, отменяется штатно, а не падает при подготовке (RUN-SETUP-STALE-TASK)

- 14.11 (кандидат 1.6.9-rc.2) прогон `issue_assigned` ждал слот агента, пока задачу закрыли и влили её PR. При старте он
  падал: `setup_failed` / `continuation_task_ownership_changed`, запись уровня error; за 7 суток таких падений 17.
  Проверка при взятии его пропускала: прогон назначения несёт комментарий-передачу, а любой прогон с комментарием
  обходил проверку «терминальный статус».
- Обход по комментарию больше не действует для `issue_assigned`: такой прогон по задаче в `done`/`cancelled` отменяется при
  взятии с кодом `issue_terminal_status` (уровень info, без `failed`). Прогоны по комментарию, намерению возобновить и
  адресаты карточек работают как раньше; настоящие сбои подготовки остаются `failed` с записью error.
