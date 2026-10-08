## changelog-en

### Board processes: the process registry and the «Processes» panel (PROCS-0.1)

- A board process now says that it is alive. The new table `board_processes` holds one row per
  running process — boot id, role, pid, host, container, version, start time, last pulse, api port
  and the measurements of the last pulse (event-loop lag and RSS). The boot id is a random UUID per
  process, exactly like the controller boot id, because a pid and a hostname survive neither a
  container restart nor a filename collision.
- Every process refreshes its own row every 10 seconds; rows older than two minutes are reaped by
  the process that owns the background timers. This is the fourth brick of the multi-process project
  (design §5.1): the split cannot be argued without a place that says which processes exist and
  which of them still answer, and ownership checks ("is the owner of this row alive?") need exactly
  this row.
- Instance → General carries the «Processes» panel: role, boot id, pid/host/container, api port,
  version, uptime, the age of the last pulse, the loop lag and the RSS of each process, with the
  process that answers the request marked as "this process". The panel polls at the pulse cadence,
  so a process that stops answering turns amber within one tick — no restart needed. A warning
  appears while this very process has no row of its own yet.
- `GET /metrics` answers one more family: `myrmidon_board_event_loop_utilization`, the share of the
  event-loop window the process was busy (0..1), from `performance.eventLoopUtilization`,
  read-and-reset so the number describes the interval between scrapes.
- The default mode does not change: with `mode=single` the one process writes one row with role
  `all` and does the reaping itself, so the behaviour of the board today is exactly what it was.
  Roles `worker`/`api` of T1.1 arrive with the same table and the same pulse; an `api` child writes
  its row and deletes nothing.

## changelog-ru

### Процессы доски: реестр процессов и панель «Процессы» (PROCS-0.1)

- Процесс доски теперь говорит, что он жив. Новая таблица `board_processes` хранит по строке на
  работающий процесс — идентификатор загрузки, роль, PID, хост, контейнер, версию, время старта,
  последний пульс, порт API и замеры последнего пульса (задержка цикла событий и RSS).
  Идентификатор загрузки — случайный UUID на процесс, как у идентификатора загрузки контроллера:
  ни PID, ни имя хоста не переживают перезапуск контейнера и не защищают от совпадения имён.
- Каждый процесс обновляет свою строку раз в 10 секунд; строки старше двух минут удаляет процесс,
  владеющий фоновыми таймерами. Это четвёртый кирпич проекта «несколько процессов доски»
  (дизайн, §5.1): без места, которое отвечает, какие процессы есть и кто из них ещё откликается,
  нельзя ни обсуждать разделение, ни проверять владение («жив ли владелец этой строки?»).
- В «Настройках экземпляра» → «General» появилась панель «Процессы»: роль, идентификатор
  загрузки, PID и хост с контейнером, порт API, версия, время работы, возраст последнего пульса,
  задержка цикла и RSS каждого процесса, причём процесс, отвечающий на запрос, помечен «этот
  процесс». Панель опрашивает сервер в такт пульса, поэтому переставший отвечать процесс желтеет
  в пределах одного такта — без перезапуска. Пока у самого процесса ещё нет своей строки,
  показывается предупреждение.
- `GET /metrics` отвечает ещё одним семейством: `myrmidon_board_event_loop_utilization` — доля
  интервала, которую процесс занимал цикл событий (0..1), из `performance.eventLoopUtilization`,
  чтение-со-сбросом, поэтому число описывает интервал между скрейпами.
- Поведение по умолчанию не меняется: при `mode=single` единственный процесс пишет одну строку с
  ролью `all` и сам чистит устаревшие, так что сегодняшнее поведение доски — прежнее. Роли
  `worker`/`api` из T1.1 придут на ту же таблицу и тот же пульс; дочерний процесс роли `api`
  пишет свою строку и не удаляет ничего.

## divergence-new

<!-- after: 1.7 — METRICS: собственные метрики доски в формате Prometheus (часть A) -->
### 1.6.6 — PROCS-0.1: реестр процессов доски и панель «Процессы»

| PROCS-0.1 | Таблица `board_processes` и панель «Процессы»: пульс процесса раз в 10 с с замерами (задержка цикла, RSS), чистка строк старше 2 мин владельцем таймеров, чтение `GET /api/myrmidon/board-processes`, семейство `myrmidon_board_event_loop_utilization` в существующей экспозиции и вторая гистограмма пульса, чтобы 10-секундный пульс не укорачивал окно `myrmidon_board_event_loop_lag_seconds` | `server/src/app.ts` (монтирование маршрута, метка `myrmidon(PROCS-0.1)`), `server/src/index.ts` (старт пульса и его остановка), `server/src/myrmidon/monitoring/metrics/process-metrics.ts` (гистограмма пульса и `eventLoopUtilization`), `server/src/myrmidon/monitoring/metrics/metrics.ts` (семейство) + `server/src/myrmidon/process-registry/{domain,store,pulse,routes,index}.ts`, `packages/db/src/schema/board_processes.ts` (+ миграция `0311_board_processes.sql`), `ui/src/components/myrmidon/{BoardProcessesSettingsPanel.tsx,boardProcessesApi.ts}`, `ui/src/pages/InstanceGeneralSettings.tsx` (и строка ключей `processes.*` в `ui/src/i18n/myrmidon-locales/{en,ru}.json`) | Этап 0 PROCS-0.1 (дизайн, §5.1): разделение доски на процессы невозможно без реестра, который говорит, какие процессы живы и кому принадлежит фоновый таймер; вендорского реестра процессов доски и метрики утилизации цикла нет | `server/src/myrmidon/process-registry/process-registry.myrmidon.test.ts` (роль, владение чисткой, граница устаревания, отдача маршрута и отказ агенту), `server/src/myrmidon/process-registry/pulse.myrmidon.test.ts` (запись строки с замерами, ровно один проход чистки, немедленный пульс на старте, остановка, сбой не бросает), `server/src/myrmidon/monitoring/metrics/process-metrics.myrmidon.test.ts` (утилизация 0..1, окно пульса не съедает окно скрейпа), `server/src/myrmidon/monitoring/metrics/exposition.myrmidon.test.ts` (семейство и образцы в экспозиции), `ui/src/components/myrmidon/BoardProcessesSettingsPanel.myrmidon.test.tsx` (панель на en и ru, устаревшая строка, пустое состояние и ошибка) | Никогда, наше поведение: при `mode=single` по умолчанию ничего в пути вендора не меняется. Когда вендор заведёт собственный реестр процессов доски и метрику утилизации цикла — удалить точки с меткой `myrmidon(PROCS-0.1)` в `app.ts`, `index.ts`, `metrics.ts`, `process-metrics.ts`, затем модуль `server/src/myrmidon/process-registry/**` и панель с ключами локализации; миграция `0311` односторонняя (CONVENTIONS §8), таблицу оставить или снять отдельной миграцией | (этот PR) |