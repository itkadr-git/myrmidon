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
