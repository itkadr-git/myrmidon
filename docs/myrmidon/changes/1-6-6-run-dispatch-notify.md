## changelog-en

### Run start dispatch over the process bus: the `notify` mode (1.6.6 RUN-DISPATCH-NOTIFY)

- Part B of T1.4. With `general.processes.runStartDispatch = "notify"`, a
  process that must not execute runs (`role.executesRuns = false`, the api
  role of T1.1) no longer starts a run locally: it publishes
  `run_queued {agentId, companyId, schemaVersion: 1}` to the process bus
  (T1.3) and the executor process's listener lifts the queued run via
  `startNextQueuedRunForAgent`. The executor itself starts inline in every
  mode and additionally publishes, so a second executor reacts without
  waiting for its resweep.
- The worker listener subscribes to `run_queued` on the bus; every bus
  (re-)listen fires the part-A resweep as the reconnect catch-up — a NOTIFY
  lost while the connection was down is recovered within one resweep
  interval, per the design rule «NOTIFY is the accelerator, the timer is
  correctness» (OPE-5394 section 0 item 2). A burst of messages for one
  agent folds into a single start attempt; a second attempt is a no-op on
  the vendor agent start lock anyway (one `controllerBootId` per run).
- The resweep timer and the bus subscription now follow the role: an api
  process arms neither; the single-process default (`inline`, no
  `PAPERCLIP_PROCESS_ROLE`) is byte-for-byte the behaviour of part A and of
  main.
- The bus starts only in a multi-process deployment
  (`PAPERCLIP_PROCESS_ROLE` set to a role value). Its postgres.js client is
  dedicated (`max: 1`, `createPostgresJsClient` in `@paperclipai/db`): a
  `sql.listen` connection is pinned for the lifetime of the listener and
  never shares the drizzle pool. A bus that fails to start degrades the
  `notify` mode to the resweep — logged, never fatal.

## changelog-ru

### Диспетчер старта прогонов по шине процессов: режим `notify` (1.6.6 RUN-DISPATCH-NOTIFY)

- Часть B T1.4. В режиме `general.processes.runStartDispatch = "notify"`
  процесс, которому нельзя исполнять прогоны (`role.executesRuns = false`,
  роль api из T1.1), больше не стартует прогон локально: он публикует
  `run_queued {agentId, companyId, schemaVersion: 1}` в шину процессов
  (T1.3), а слушатель на процессе-исполнителе поднимает queued-прогон через
  `startNextQueuedRunForAgent`. Сам исполнитель стартует inline в любом
  режиме и дополнительно публикует — второй исполнитель реагирует, не дожидаясь
  своего resweep.
- Слушатель исполнителя подписан на `run_queued`; каждый (пере)listen шины
  запускает resweep части A как догон при переподключении — NOTIFY,
  потерянный пока соединение было разорвано, восстанавливается за один
  интервал resweep, по правилу дизайна «NOTIFY — ускорение, таймер —
  корректность» (OPE-5394, раздел 0 п.2). Серия сообщений по одному агенту
  складывается в одну попытку старта; вторая попытка в любом случае no-op на
  вендорном agent start lock (один `controllerBootId` на прогон).
- Таймер resweep и подписка на шину теперь следуют за ролью: api-процесс не
  взводит ни того, ни другого; дефолт с одним процессом (`inline`, без
  `PAPERCLIP_PROCESS_ROLE`) — поведение части A и main байт в байт.
- Шина стартует только в многопроцессном развёртывании
  (`PAPERCLIP_PROCESS_ROLE` задан). Её postgres.js-клиент выделенный
  (`max: 1`, `createPostgresJsClient` в `@paperclipai/db`): соединение
  `sql.listen` закреплено за слушателем на всё время жизни и не делит пул
  drizzle. Шина, которая не поднялась, деградирует режим `notify` до
  resweep — с записью в лог, никогда не фатально.

## divergence-new

### 1.6.6 — RUN-DISPATCH-NOTIFY: режим notify диспетчера старта прогонов поверх шины процессов

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.6.6-RUN-DISPATCH-NOTIFY | Ветка `notify` диспетчера: процесс с `executesRuns = false` публикует `run_queued` в шину вместо локального старта, исполнитель стартует inline в любом режиме и дополнительно публикует. Слушатель `run_queued` в исполнителе: старт `startNextQueuedRunForAgent(agentId)` по сообщению, resweep-догон на каждый (пере)listen шины, склейка серии сообщений по одному агенту. Правило взведения resweep получило гейт роли (`process_role`): api-процесс таймер не взводит. Шина поднимается в `server/src/index.ts` только при заданном `PAPERCLIP_PROCESS_ROLE` (клиент `createPostgresJsClient` с `max: 1`); отказ шины — деградация до resweep с логом. Дефолт (один процесс, `inline`) — поведение main без изменений | `server/src/myrmidon/run-dispatch/index.ts` (ветка notify по роли, `RUN_QUEUED_CHANNEL`, `parseRunQueuedPayload` / `buildRunQueuedPayload`, `createRunQueuedBusListener`, гейт роли в `queuedResweepArmDecision`); в вендоре помечены `myrmidon(1.6.6 RUN-DISPATCH-NOTIFY)`: `server/src/services/heartbeat.ts` (deps `executesRuns` / `requestRemoteStart` / слушатель с опцией `processBus`, гейт роли во взведении таймера, снятие слушателя в `drainActiveRunExecutions`), `server/src/index.ts` (конструирование и старт `ProcessBus`, останов в shutdown, передача в `heartbeatService`); `packages/db/src/client.ts` + `index.ts` (`createPostgresJsClient`) | Часть A резервировала режим `notify` маркером без шины; без части B api-процессы продолжали бы стартовать прогоны сами, и многопроцессный запуск доски не имел бы мгновенной реакции исполнителя на постановку прогона в очередь | `server/src/__tests__/run-dispatch-notify.myrmidon.test.ts` (чистая часть: гейт роли в ветке notify, слушатель `run_queued` — старт по сообщению, отброс битого payload, склейка серии, resweep-догон на (пере)listen, деградация при падении старта, гейт роли в правиле взведения resweep, контракт payload); прогон части A (`run-dispatch-inline-resweep.myrmidon.test.ts`, `queued-run-resweep.myrmidon.test.ts`) не менялся | Когда вендор заведёт собственную шину процессов и диспетчер старта — удалить куски `myrmidon(1.6.6 RUN-DISPATCH-NOTIFY)` и `myrmidon(1.6.6 RUN-DISPATCH)`. Гейт роли подменяется на `role.executesRuns` из T1.1, когда тот влит (сейчас роль приходит опцией heartbeatService; `PAPERCLIP_PROCESS_ROLE` читается только в index.ts) | (этот PR) |
