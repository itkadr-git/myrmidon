## changelog-en

### Checks of a cancelled, superseded CI run no longer turn the board's CI summary red (CI-SNAPSHOT-CANCELLED)

- The CI summary the board gives agents (`ciResult` / `pullRequestsCi`) now counts, for each check name, only its latest record on the head (latest start, then completion time, then larger id). The last completed record with a verdict represents the check; earlier records of it (cancelled by a replaced run, or failed before a re-run) no longer take part. This fixes a false FAILURE on pull requests where adding `full-ci` or a re-run replaced the running CI.
- A check whose latest record is `cancelled` and has no replacement is reported as "cancelled, not a test failure": the overall conclusion is `cancelled` (neither `failure` nor `success`), the new `cancelledJobs` field lists it, and `failedJobs` is left for real `failure` / `timed_out` / `action_required`.
- A later `skipped`, `neutral` or `cancelled` record never hides an earlier verdict (`success` / `failure` / ...) of the same check: a real failure stays FAILURE.
- A successful `CI result` with no real failures gives `success` and absorbs only cancelled required checks of its own workflow run; other cancelled required checks keep the summary `cancelled`.

## changelog-ru

### Проверки отменённого и заменённого прогона CI больше не делают сводку CI доски красной (CI-SNAPSHOT-CANCELLED)

- Сводка CI, которую доска отдаёт агентам (`ciResult` / `pullRequestsCi`), теперь для каждого имени проверки учитывает только последнюю запись на голове (позднее начало, затем завершение, затем больший id). Более ранние записи той же проверки (отменённые заменённым прогоном или упавшие до перезапуска) в подсчёте не участвуют. Исправляет ложный FAILURE на PR, где метка `full-ci` или перезапуск заменили идущий CI.
- Проверка, чья последняя запись `cancelled` и замены нет, показывается как «cancelled, not a test failure»: общий итог `cancelled` (не `failure` и не `success`), новое поле `cancelledJobs` перечисляет её, а `failedJobs` остаётся для настоящих `failure` / `timed_out` / `action_required`.
- Более поздняя запись `skipped`, `neutral` или `cancelled` не скрывает более раннего вердикта той же проверки: настоящий провал остаётся FAILURE.
- Успешная `CI result` без настоящих падений даёт `success` и гасит только отменённые обязательные проверки своего прогона; остальные отменённые обязательные проверки оставляют итог `cancelled`.
