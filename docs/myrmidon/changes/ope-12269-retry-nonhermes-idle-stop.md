## changelog-en

### Heartbeat: non-hermes agents skip bot container idle-stop check during transient retry (1.6.7 RETRY-NONHERMES, OPE-12269)

- In `heartbeatService.claimQueuedRun()`, the IDLE-STOP container health check (`idleStopService.ensureStartedAndHealthy()`) is now guarded to only run for `hermes_gateway` agents that have `adapterConfig.container.enabled === true`.
- Previously, scheduled retries with cause `transient_failure_retry` for agents with non-hermes adapters (such as `omp_local` or `codex_local`) invoked the container check without verifying adapter type, causing immediate `hermes_gateway_connect_failed: dockergate: denied (bot_not_enrolled)` failures, infinite retry loops, and stranded task execution locks. Non-hermes agents now follow the standard adapter dispatch path during retry.

## changelog-ru

### Heartbeat: агенты не на hermes пропускают проверку контейнера idle-stop при повторе прогона (1.6.7 RETRY-NONHERMES, OPE-12269)

- В `heartbeatService.claimQueuedRun()` запуск и проверка контейнера бота через IDLE-STOP (`idleStopService.ensureStartedAndHealthy()`) ограничены только агентами с адаптером `hermes_gateway` и флагом `adapterConfig.container.enabled === true`.
- Ранее повторный запуск прогона с причиной `transient_failure_retry` у агентов на других адаптерах (`omp_local`, `codex_local`) вызывал проверку контейнера бота без проверки типа адаптера, что приводило к ошибке `hermes_gateway_connect_failed: dockergate: denied (bot_not_enrolled)`, зацикливанию повторов и удержанию блокировки выполнения задачи. Теперь повтор у таких агентов идёт тем же путём через соответствующий адаптер.
