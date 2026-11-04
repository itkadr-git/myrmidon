## changelog-en

### Engineer idle and unblocked task metrics in /metrics

- The `/metrics` endpoint exposes `myrmidon_engineers_live` (count of live, unpaused engineer agents).
- The `/metrics` endpoint exposes `myrmidon_engineers_idle` (count of live engineer agents without a heartbeat run in the idle window, default 60 minutes, configurable via `?idle_window=`).
- The `/metrics` endpoint exposes `myrmidon_todo_unblocked_tasks` (count of todo issues without user assignment and without open blocking relations).

## changelog-ru

### Метрики простоя инженеров и незаблокированных задач в /metrics

- Эндпоинт `/metrics` публикует gauge `myrmidon_engineers_live` (количество живых агентов-инженеров, не terminated и не на паузе).
- Эндпоинт `/metrics` публикует gauge `myrmidon_engineers_idle` (количество живых инженеров без прогонов за окно простоя, по умолчанию 60 минут, настраивается параметром `?idle_window=`).
- Эндпоинт `/metrics` публикует gauge `myrmidon_todo_unblocked_tasks` (количество задач todo без назначения на пользователя и без открытых блокирующих связей).

## divergence-new

<!-- after: 1.6.6 — MONITORING: метрики фаз прогонов и сторож reconnecting (OPE-10046) -->

### 1.6.6 — MONITORING: метрики простоя инженеров для Zabbix (OPE-9868 / OPE-10927)

| ID | Что изменено | Файлы | Зачем | Тест-сторож | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.6.6-ENGINEER-IDLE-METRICS | Экспозиция `/metrics` публикует три gauge: `myrmidon_engineers_live`, `myrmidon_engineers_idle` (окно по умолчанию 60 минут, параметр `?idle_window=`) и `myrmidon_todo_unblocked_tasks`. Запросы соответствуют логике хостового сторожа `eng-idle-watch.sh`. | `server/src/myrmidon/monitoring/metrics/{metrics,routes}.ts`, `docs/myrmidon/changes/engineer-idle-metrics.md` | Перенос хостового скрипта `eng-idle-watch.sh` в Zabbix по правилу «Сторожа это мониторинг!» (OPE-9868) | `server/src/myrmidon/monitoring/metrics/{exposition,collector.db}.myrmidon.test.ts` | Никогда, штатный мониторинг | (этот PR) |

## settings-en-new

<!-- after: 1.7 — METRICS: the board's own /metrics endpoint (Prometheus text) -->

### Engineer Idle & Unblocked Tasks Metrics (1.6.6 OPE-9868)

The `/metrics` endpoint exposes three gauges for monitoring engineer utilization:
- `myrmidon_engineers_live{role="all"}`: Number of active engineer agents (role `engineer` or name matching `adm-dev-eng-*`, status not `terminated`, `pausedAt` is null).
- `myrmidon_engineers_idle{role="all"}`: Number of live engineers without any run within the idle window (default 3600 seconds / 60 minutes, query parameter `?idle_window=`).
- `myrmidon_todo_unblocked_tasks{role="all"}`: Number of `todo` issues without user assignment (`assigneeUserId` is null) and without open blocking relations (`type = 'blocks'`).
