## changelog-en

### Suppress replacement wake for queued runs cancelled due to terminal issue status (OPE-13068)

When a queued run was cancelled during queue sweep because its associated issue had reached a terminal status (`done` or `cancelled`), the sweep loop erroneously created a replacement wake with reason `queued_run_stale_timeout`. This led to infinite loops of creating and immediately cancelling runs for closed tasks.
Fix:
1. In `server/src/modules/run-dispatch/adapters/postgres.ts`, evaluate task staleness (including terminal status) before applying the age-based stale timeout.
2. In `server/src/services/heartbeat.ts`, ensure `createCancelStaleQueuedRun` only triggers a replacement wake when the cancellation error code is actually `queued_run_stale_timeout`.

## changelog-ru

### Запрет постановки замены для прогонов, снятых по терминальному статусу задачи (OPE-13068)

Когда прогон в очереди снимался обходом очереди из-за того, что задача перешла в конечный статус (`done` или `cancelled`), очередь ошибочно создавала ему замену с причиной побудки `queued_run_stale_timeout`. Это приводило к бесконечному циклу создания и снятия прогонов по закрытым задачам.
Исправление:
1. В `server/src/modules/run-dispatch/adapters/postgres.ts` проверка статуса задачи (включая терминальные статусы) выполняется до применения тайм-аута устаревания по возрасту.
2. В `server/src/services/heartbeat.ts` вызов `createCancelStaleQueuedRun` возвращает флаг для постановки замены только в том случае, если прогон был снят именно по причине `queued_run_stale_timeout`.
