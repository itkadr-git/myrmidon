## changelog-en

### Daily board cleanup no longer moves backlog, blocked and review tasks to todo, and its status changes are logged (OPE-13327)

- On 16.11 at 08:00 the daily cleanup rule "unassigned release task" (`queue_unassigned_release`) took every open release task without an assignee and set its status to `todo`. 21 tasks moved to `todo`, among them 12 tasks that were parked in `backlog` on purpose. The distribution gave 6 of them to engineers, and all 6 runs were empty.
- The rule now applies only to unassigned release tasks that are already in `todo`. It does not change the status: it only tells the distribution and leaves a comment. Tasks in `backlog`, `blocked`, `in_review` and `in_progress` are not touched and do not appear in section 5 of the cleanup report.
- Every status change by the cleanup (`close_merged_pr`, `unblock_stale`, `move_stale_to_backlog`) now writes an `activity_log` row in the same transaction: action `issue.updated`, actor `system` / `board_janitor`, details `source: board_janitor`, `identifier`, `changes.status` (`from`, `to`) and `rule`. Before, the cleanup wrote the status directly and left no trace.

## changelog-ru

### Ежедневная уборка доски больше не переводит задачи из backlog, blocked и ревью в todo, а её смены статуса пишутся в журнал (OPE-13327)

- 16.11 в 08:00 правило уборки «задача выпуска без исполнителя» (`queue_unassigned_release`) взяло каждую открытую задачу выпуска без исполнителя и поставило ей статус `todo`. В `todo` ушли 21 задача, среди них 12 задач, сознательно отложенных в `backlog`. Раздача выдала 6 из них инженерам, и все 6 прогонов оказались пустыми.
- Теперь правило работает только для задач выпуска без исполнителя, которые уже в `todo`. Статус оно не меняет: только оповещает раздачу и оставляет комментарий. Задачи в `backlog`, `blocked`, `in_review` и `in_progress` правило не трогает, и в разделе 5 отчёта уборки их нет.
- Каждая смена статуса уборкой (`close_merged_pr`, `unblock_stale`, `move_stale_to_backlog`) теперь пишет строку в `activity_log` в той же транзакции: действие `issue.updated`, актор `system` / `board_janitor`, в details `source: board_janitor`, `identifier`, `changes.status` (`from`, `to`) и `rule`. Раньше уборка писала статус напрямую и следа не оставляла.
