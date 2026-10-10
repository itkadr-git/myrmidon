## changelog-en

### Run start dispatcher and a 30 s resweep for queued runs (1.6.6 RUN-DISPATCH)

- One point of choice for how a start attempt is dispatched:
  `general.processes.runStartDispatch` (`inline` / `notify`, default `inline`).
  `inline` is the existing behaviour, byte for byte: the process that decided to
  start a run starts it. `notify` reserves the start for the executor process over
  the process bus (1.6.6 PROCS, T1.3).
- New periodic resweep: every `general.processes.queuedResweepSec` seconds
  (default 30, range 5..3600) the process takes the agents that have a `queued`
  run and NO `running` run, and lifts their oldest queued run
  (`startNextQueuedRunForAgent`). It is the fallback for a start notification that
  never arrives — such a run used to wait for the 5-minute scheduler tick
  (`resumeQueuedRuns`) or for the one-shot 15 s timer after an admission denial
  (`run-admission.ts`).
- Both keys live in `instance_settings.general.processes`, no migration. The mode
  is re-read on every dispatch and the interval on every cycle, so a saved change
  applies without a restart (live application on `settings_changed` is 1.6.6 T1.8).
- Operations: the timer is background work of the heartbeat service — it stays
  off under a test runner and can be switched off with `MYRMIDON_QUEUED_RESWEEP`
  set to `0`.
- Part A of T1.4. Part B replaces the local markers with the role gate
  (`role.executesRuns`, T1.1) and the `run_queued` bus publish.

## changelog-ru

### Диспетчер старта прогонов и resweep очереди раз в 30 с (1.6.6 RUN-DISPATCH)

- Единая точка выбора стратегии старта: `general.processes.runStartDispatch`
  (`inline` / `notify`, по умолчанию `inline`). `inline` — текущее поведение,
  байт в байт: прогон стартует тот процесс, который решил его начать. `notify`
  оставляет старт процессу-исполнителю через шину процессов (1.6.6 PROCS, T1.3).
- Новый периодический resweep: раз в `general.processes.queuedResweepSec` секунд
  (по умолчанию 30, диапазон 5..3600) процесс берёт агентов, у которых есть
  прогон `queued` и НЕТ ни одного `running`, и поднимает их самый старый прогон
  (`startNextQueuedRunForAgent`). Это фолбэк для уведомления о старте, которое не
  дошло: раньше такой прогон ждал тика планировщика в 5 минут
  (`resumeQueuedRuns`) или одноразового таймера 15 с после отказа admission
  (`run-admission.ts`).
- Оба ключа живут в `instance_settings.general.processes`, без миграций. Режим
  перечитывается на каждый старт, интервал — на каждый цикл, поэтому сохранённое
  значение применяется без перезапуска (живое применение по `settings_changed` —
  зона 1.6.6 T1.8).
- Эксплуатация: таймер — фоновая работа сервиса heartbeat; под тест-раннером он
  не взводится, а в бою глушится `MYRMIDON_QUEUED_RESWEEP` (значение `0`).
- Часть A T1.4. Часть B подменяет локальные маркеры гейтом роли
  (`role.executesRuns`, T1.1) и публикацией `run_queued` в шину.

## divergence-new

### 1.6.6 — RUN-DISPATCH: диспетчер старта прогонов (inline по умолчанию) и resweep «queued без running» раз в 30 с

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.6.6-RUN-DISPATCH | Единый диспетчер старта прогона: `general.processes.runStartDispatch` (`inline` — по умолчанию, поведение main байт в байт; `notify` оставляет старт процессу-исполнителю через шину процессов) и периодический resweep `general.processes.queuedResweepSec` (по умолчанию 30 с, диапазон 5..3600): процесс берёт агентов с прогоном `queued` и без единого `running` и поднимает их самый старый прогон через `startNextQueuedRunForAgent` — идемпотентно на вендорном agent start lock. Оба ключа читаются сырым jsonb `instance_settings.general` (`getGeneral` фильтрует ключи белым списком, поэтому `processes` до T1.1 через него не видно) и перечитываются без перезапуска. Таймер не взводится под тест-раннером (`VITEST` / `NODE_ENV=test`) и глушится `MYRMIDON_QUEUED_RESWEEP` (значение `0`). Ключ `notify` и локальные маркеры заменяются гейтом роли в части B | `server/src/myrmidon/run-dispatch/index.ts`, `server/src/myrmidon/run-dispatch/settings.ts`; в вендоре помечены `myrmidon(1.6.6 RUN-DISPATCH)`: `server/src/services/heartbeat.ts` (импорт модуля, диспетчер и таймер сразу после `startNextQueuedRunForAgent`, снятие таймера в `drainActiveRunExecutions`, член `sweepQueuedRunsWithoutRunning` в возвращаемом объекте сервиса) | Старт `queued`-прогона шёл только из пробуждения агента и завершений прогонов; resweep существовал лишь как одноразовый таймер 15 с после отказа admission и тик в 300 с, поэтому потерянное уведомление о старте держало прогон в очереди до 5 минут | `server/src/__tests__/run-dispatch-inline-resweep.myrmidon.test.ts` (чистая часть: настройки и их клампы, режимы, цикл resweep, таймер на фейковых таймерах, правило взведения), `server/src/__tests__/queued-run-resweep.myrmidon.test.ts` (embedded postgres: выборка «queued без running» и отсечение по возрасту, queued→running без уведомления, повторный проход без дублей, агент с `running` не трогается) | Когда вендор заведёт собственный диспетчер старта и периодический resweep очереди — удалить куски `myrmidon(1.6.6 RUN-DISPATCH)`. Часть A T1.4 (этот PR); часть B — гейт роли `role.executesRuns` (T1.1) и публикация `run_queued` в шину процессов (T1.3) вместо локальных маркеров | (этот PR) |