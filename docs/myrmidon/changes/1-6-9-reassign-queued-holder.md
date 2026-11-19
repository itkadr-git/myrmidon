## changelog-en

### Reassignment releases a not-started queued run of the previous assignee (1.6.9 OPE-13097)

- When an issue is reassigned and its execution lock is held by a `queued` or `scheduled_retry` run of the previous assignee that has not started, that run is now cancelled (`lock_released_on_reassignment`) before the new assignee is woken.
- The new assignee's wake is queued immediately instead of waiting in `deferred_issue_execution`.
- Runs of the current review-stage participant and running runs are not touched by this path.

## changelog-ru

### Переназначение снимает не начавшийся запуск прежнего исполнителя (1.6.9 OPE-13097)

- При переназначении задачи, если замок исполнения держит не начавшийся запуск прежнего исполнителя в состоянии `queued` или `scheduled_retry`, этот запуск отменяется (`lock_released_on_reassignment`) до побудки нового исполнителя.
- Побудка нового исполнителя встаёт в очередь сразу, а не ждёт в `deferred_issue_execution`.
- Запуски участника этапа ревью и идущие запуски этот путь не затрагивает.
