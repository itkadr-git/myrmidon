---

---

## changelog-en

### IDLE-STOP: stop idle bot containers, wake on demand with health check (IDLE-STOP)

- Periodic sweeper stops bot containers that have had no active heartbeat runs
  for longer than `MYRMIDON_IDLE_STOP_AFTER_SEC` (default 30 min), via
  `BotContainerDriver.stop(botKey)` — the driver itself is unchanged.
- Before a claimed run starts, the board wakes a stopped container with
  `driver.start(botKey)` and waits for it to become healthy, up to
  `MYRMIDON_IDLE_START_HEALTH_TIMEOUT_MS` (default 30 s). On timeout the run is
  cancelled with a clear journal error — it never starts blind.
- Cold-start duration (start → healthy) is logged for every wake.
- The whole feature is off by default behind `MYRMIDON_IDLE_STOP_ENABLED`.

## changelog-ru

### IDLE-STOP: остановка простаивающих контейнеров ботов, запуск побудкой с ожиданием здоровья (IDLE-STOP)

- Периодический sweeper останавливает контейнеры ботов без активных прогонов
  дольше `MYRMIDON_IDLE_STOP_AFTER_SEC` (по умолчанию 30 мин) через
  `BotContainerDriver.stop(botKey)` — сам драйвер не меняется.
- Перед стартом прогона доска поднимает остановленный контейнер
  (`driver.start(botKey)`) и ждёт healthy до `MYRMIDON_IDLE_START_HEALTH_TIMEOUT_MS`
  (по умолчанию 30 с). При таймауте прогон отменяется с понятной ошибкой в
  журнале — вслепую не стартует.
- Длительность холодного старта (start → healthy) пишется в журнал.
- Вся функция выключена по умолчанию за `MYRMIDON_IDLE_STOP_ENABLED`.

## settings-en-new

<!-- after: Bot containers (G-series, the 28.09 "option B" plan) -->
### 1.2 — IDLE-STOP (idle bot containers)

| Variable | Default | Description |
| --- | --- | --- |
| `MYRMIDON_IDLE_STOP_ENABLED` | `false` | Enable the idle-stop sweeper and the wake-with-health-wait path. Off by default; when off, nothing changes. |
| `MYRMIDON_IDLE_STOP_AFTER_SEC` | `1800` | A running bot container with no active heartbeat runs for longer than this is stopped by the sweeper. Minimum 60. |
| `MYRMIDON_IDLE_START_HEALTH_TIMEOUT_MS` | `30000` | How long the board waits for a woken container to become healthy before the claimed run is cancelled with a journal error. Minimum 1000. |

## settings-ru-new

<!-- after: Контейнеры ботов (G-серия, план 28.09 «вариант Б») -->
### 1.2 — IDLE-STOP (простаивающие контейнеры ботов)

| Переменная | По умолчанию | Описание |
| --- | --- | --- |
| `MYRMIDON_IDLE_STOP_ENABLED` | `false` | Включает sweeper остановки простаивающих контейнеров и побудку с ожиданием здоровья. По умолчанию выключено; при выключении ничего не меняется. |
| `MYRMIDON_IDLE_STOP_AFTER_SEC` | `1800` | Запущенный контейнер бота без активных прогонов дольше этого срока останавливается sweeper'ом. Минимум 60. |
| `MYRMIDON_IDLE_START_HEALTH_TIMEOUT_MS` | `30000` | Сколько доска ждёт healthy у разбуженного контейнера, прежде чем отменить прогон с ошибкой в журнале. Минимум 1000. |
