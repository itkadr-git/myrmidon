---
divergence-section: FLEETD-VMEXEC — контейнеры ботов разработки на второй машине
---

## changelog-en

### IDLE-STOP works for fleetd bots: stopIdle route, idle-stopped mark, one warning per process (OPE-12663)

- fleetd gains `POST /v1/bots/<key>/stopIdle`: it stops the container and records an
  `hermes/.myrmidon/idle-stopped.json` mark in the bot's volume root, the same contract the
  local docker driver has. The status and list answers carry `idleStopped: true` while the
  mark stands; a wake (`start`) or an operator stop clears it. A docker container in any
  non-running state (e.g. `exited`) now reads as `stopped`, so the reconciler honors the
  mark and leaves the container down until the next run wakes it.
- The fleetd driver client (`fleetd-driver.ts`) gained `stopIdle`, so IDLE-STOP stops bots
  on a fleetd host instead of logging the unsupported-driver error.
- The sweeper logs "driver cannot idle-stop" as a single warning per process instead of an
  error on every sweep (the condition is permanent; a real stop failure still logs an error
  per occurrence).

## changelog-ru

### IDLE-STOP работает для ботов на fleetd: маршрут stopIdle, метка idle-stopped, одно предупреждение на процесс (OPE-12663)

- fleetd получил `POST /v1/bots/<key>/stopIdle`: сервис останавливает контейнер и ставит
  метку `hermes/.myrmidon/idle-stopped.json` в корне тома бота — тот же контракт, что у
  локального docker-драйвера. Ответы status и list несут `idleStopped: true`, пока метка
  стоит; побудка (`start`) или остановка оператором её снимает. Контейнер docker в любом
  не-running состоянии (например, `exited`) теперь читается как `stopped`, так что сверщик
  honorит метку и оставляет контейнер выключенным до следующего прогона.
- Клиент драйвера fleetd (`fleetd-driver.ts`) получил `stopIdle`, поэтому IDLE-STOP
  останавливает ботов на fleetd-хосте вместо ошибки «драйвер не поддерживает».
- Сверщик пишет «драйвер не умеет останавливать по простою» одним предупреждением на
  процесс вместо ошибки на каждом проходе (условие постоянное; реальный сбой остановки
  по-прежнему логируется ошибкой на каждый случай).

## divergence

| FLEETD-VMEXEC-IDLESTOP | Остановка по простою для ботов на fleetd: драйвер-клиент `fleetd-driver.ts` получил `stopIdle` (OPE-12663) — выделенный маршрут `POST /v1/bots/<key>/stopIdle`; сервис fleetd останавливает контейнер и ставит метку `hermes/.myrmidon/idle-stopped.json` в корне тома бота (атомарно, 0600; сбой записи метки поднимает контейнер обратно и отвечает 502 — контейнер не остаётся выключенным без метки). Метка видна в status/list как `idleStopped`, снимается `start`/`stop`/create/recreate; контейнер docker в любом не-running состоянии (`exited`/`created`/`dead`) читается как `stopped`, так что сверщик honorит метку и не поднимает бот до следующего прогона (побудка поднимает — контракт A17 локального драйвера). Пока драйвер без `stopIdle`, сверщик пишет одно предупреждение на процесс вместо ошибки на каждом проходе | Только наши файлы: `tools/fleetd/cmd/fleetd/{main.go,main_test.go}`, `server/src/myrmidon/bot-containers/{fleetd-driver.ts,fleetd-driver.myrmidon.test.ts}`, `server/src/myrmidon/idle-stop.ts` (+тест); вендор не тронут | IDLE-STOP должен останавливать ботов на fleetd-площадках, а не писать ошибку `idle-stop route is not supported by this driver` (~14 тыс. строк в сутки на myr-vm1) | `TestStopIdleWritesMarkAndStartClearsIt`, `TestOperatorStopClearsIdleMark`, `TestStatusMapsExitedToStopped` (Go); `fleetd-driver.myrmidon.test.ts`, idle-stop warn-once тест (TS) | Снятие: удалить маршрут/метку и вызов `stopIdle`; сверщик вернётся к предупреждению без ошибки |
