## changelog-en

### Live runs execution phase metrics and reconnecting watchdog

- The `/metrics` endpoint exposes `myrmidon_runs_execution_phase{phase="working|reconnecting|finishing|retry_scheduled|recovery_needed|..."}` showing count of live runs by projection phase. Phases are computed using the standard `executionProjectionsForRuns` service.
- The `/metrics` endpoint exposes `myrmidon_runs_reconnecting_oldest_seconds` showing the duration in seconds of the oldest run currently hanging in `reconnecting`.
- An in-product monitoring watchdog checks live runs periodically: when >= 3 runs are in `reconnecting` for longer than 5 minutes OR > 50% of live runs are in `reconnecting`, an alert is raised in the board's alert recovery channel listing affected run IDs.
- Runbook `docs/myrmidon/runbooks/runs-reconnecting.md` documents diagnostic and remediation steps.

## changelog-ru

### Метрики фаз живых прогонов и сторож зависших прогонов в reconnecting

- Эндпоинт `/metrics` публикует gauge `myrmidon_runs_execution_phase{phase="working|reconnecting|finishing|retry_scheduled|recovery_needed|..."}` с числом живых прогонов по фазе проекции. Фазы рассчитываются общим сервисом `executionProjectionsForRuns`.
- Эндпоинт `/metrics` публикует gauge `myrmidon_runs_reconnecting_oldest_seconds` со временем (в секундах) самого старого прогона, зависшего в `reconnecting`.
- Штатный сторож мониторинга периодически проверяет живые прогоны: если не менее 3 прогонов висят в `reconnecting` дольше 5 минут ИЛИ более 50% живых прогонов находятся в `reconnecting`, сторож поднимает тревогу в штатном канале alert recovery доски с перечнем run ID.
- Runbook `docs/myrmidon/runbooks/runs-reconnecting.md` содержит регламент диагностики и устранения сбоев.

## divergence-new

<!-- after: 1.6.6 — CORPUS-2.0 C: серверная часть корпуса знаний -->

### 1.6.6 — MONITORING: метрики фаз прогонов и сторож reconnecting (OPE-10046)

| ID | Что изменено | Файлы | Зачем | Тест-сторож | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.6.6-RUNS-RECONNECTING | Экспозиция `/metrics` отдаёт два gauge: `myrmidon_runs_execution_phase{phase=...}` (число живых прогонов status running по фазе проекции через `executionProjectionsForRuns`) и `myrmidon_runs_reconnecting_oldest_seconds` (время зависания самого старого прогона в reconnecting). Внутренний сторож доски (`RunsReconnectingWatchdog`) на тиках шедулера проверяет живые прогоны: если >= 3 прогонов в reconnecting дольше 5 мин или > 50% живых прогонов в reconnecting — поднимает тревогу в канале alert-recovery / задачах с перечнем run ID. Runbook `runs-reconnecting`. | `server/src/myrmidon/monitoring/metrics/{runs-reconnecting,metrics,index}.ts`, `server/src/myrmidon/monitoring/alert-recovery/runbook.ts`, `server/src/index.ts`, `docs/myrmidon/runbooks/runs-reconnecting.md`, `docs/myrmidon/changes/runs-reconnecting-metrics.md` | Инцидент 30.10 (OPE-9924/#2008): прогоны часами висели в reconnecting, ревьюеры простаивали, мониторинг доски проблему не показывал. Внутренний мониторинг и тревога заменяют внешний скрипт оператора | `server/src/myrmidon/monitoring/metrics/runs-reconnecting.myrmidon.test.ts` (расчёт фаз, условие тревоги >=3 >5мин, условие >50%, перечень run ID, экспозиция обоих gauge, watchdog sweep) | Никогда, наше поведение | (этот PR) |

## settings-en-new

<!-- after: 1.7 — METRICS: the board's own /metrics endpoint (Prometheus text) -->

### Runs Execution Phase & Reconnecting Watchdog (1.6.6 rc.19 MONITORING OPE-10046)

The `/metrics` endpoint exposes two gauges for monitoring live run health:
- `myrmidon_runs_execution_phase{role="all",phase="..."}`: Gauge of live runs (status `running`) by execution projection phase (`working`, `reconnecting`, `finishing`, `retry_scheduled`, `recovery_needed`). Computed using the standard `executionProjectionsForRuns` service.
- `myrmidon_runs_reconnecting_oldest_seconds{role="all"}`: Duration in seconds of the oldest run currently hanging in `reconnecting` (0 when no runs are reconnecting).

In-product watchdog `RunsReconnectingWatchdog` periodically inspects live runs. If >= 3 runs are in `reconnecting` for > 5 minutes OR > 50% of live runs are in `reconnecting`, it raises an alert in the board's alert recovery system with runbook `runs-reconnecting` listing affected run IDs.
