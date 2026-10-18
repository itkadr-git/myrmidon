## changelog-en

### Process supervisor — fork, reusePort, IPC ready/drain, backoff, emergency return to single (PROCS-1.2, OPE-6425)

- `server/src/myrmidon/processes/supervisor.ts` — the worker's child-process
  supervisor: forks `server/dist/index.js` with the same execArgv (including
  `--import tsx/loader`), `PAPERCLIP_PROCESS_ROLE=api`,
  `PAPERCLIP_PARENT_BOOT_ID`, and a per-child `--max-old-space-size` (api
  1 GiB); restarts a crashed child on a 1 s → 30 s backoff; when no live api
  child remains for 15 s the worker re-opens :3100 itself (emergency return
  to single) and logs the attention signal.
- `server/src/myrmidon/processes/child.ts` — the api child's side of the IPC
  contract: `ready` after `listening` + `SELECT 1`; `drain` runs
  `server.close()` + `closeIdleConnections()`, closes live-events websocket
  clients with 1012, and exits after the 30 s grace via
  `closeAllConnections()`.
- `server/src/index.ts` — the worker's public listener is supervisor-managed:
  single→split forks the children and closes the worker's :3100 once all
  report ready; split→single re-opens :3100 (reusePort while children still
  hold it) and drains them one by one; the worker's shutdown stops the
  supervisor first. The api role skips the heartbeat/sweep scheduler block and
  gets a smaller database pool (6 connections).
- `server/src/myrmidon/processes/service.ts` — `PATCH
  /api/myrmidon/processes` now applies live through the supervisor (design
  OPE-5394 §7.2), no container restart; `PAPERCLIP_PROCESS_MODE=single` still
  wins over the database at boot.
- `packages/shared/src/myrmidon-processes.ts` —
  `PROCESSES_SUPERVISOR_IMPLEMENTED` flipped to true; a stored `split` is in
  effect instead of reported unsupported.
- `server/src/myrmidon/processes/supervisor.myrmidon.test.ts` — unit tests:
  single inertness, single→split with readiness gate, apiCount up/down with
  IPC drain, split→single, the backoff ladder, the emergency fallback, and
  shutdown.

## changelog-ru

### Супервизор процессов — fork, reusePort, IPC ready/drain, бэкофф, аварийный возврат в single (PROCS-1.2, OPE-6425)

- `server/src/myrmidon/processes/supervisor.ts` — супервизор детей в
  worker-процессе: fork `server/dist/index.js` с теми же execArgv (включая
  `--import tsx/loader`), `PAPERCLIP_PROCESS_ROLE=api`,
  `PAPERCLIP_PARENT_BOOT_ID`, память api-ребёнка 1 ГБ через
  `--max-old-space-size`; рестарт упавшего ребёнка с бэкоффом 1 с → 30 с;
  если 15 с нет ни одного живого api-ребёнка, worker сам открывает :3100
  (аварийный возврат в single) и пишет сигнал внимания в журнал.
- `server/src/myrmidon/processes/child.ts` — сторона api-ребёнка: `ready`
  после `listening` и `SELECT 1`; по IPC `drain` — `server.close()` +
  `closeIdleConnections()`, websocket-клиентам `close(1012)`, через грейс
  30 с — `closeAllConnections()` и `exit 0`.
- `server/src/index.ts` — публичный listener worker'а управляется
  супервизором: single→split форкает детей и закрывает :3100 worker'а после
  их `ready`; split→single открывает :3100 (reusePort при живых детях) и
  дрейнит их по одному; shutdown worker'а сначала останавливает супервизор.
  Роль api пропускает блок heartbeat/свипов и получает уменьшенный пул БД
  (6 соединений).
- `server/src/myrmidon/processes/service.ts` — `PATCH
  /api/myrmidon/processes` применяется на живую через супервизор (дизайн
  OPE-5394 §7.2), без перезапуска контейнера; `PAPERCLIP_PROCESS_MODE=single`
  по-прежнему читается раньше БД.
- `packages/shared/src/myrmidon-processes.ts` —
  `PROCESSES_SUPERVISOR_IMPLEMENTED` переключён в true: сохранённый `split`
  считается действующим.
- `server/src/myrmidon/processes/supervisor.myrmidon.test.ts` — юнит-тесты:
  инертность single, single→split с гейтом готовности, apiCount вверх/вниз с
  IPC drain, split→single, лестница бэкоффа, аварийный возврат, shutdown.
