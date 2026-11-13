## changelog-en

### Checks of a cancelled, superseded CI run no longer turn the board's CI summary red (CI-SNAPSHOT-CANCELLED)

- The CI summary the board gives agents (`ciResult` / `pullRequestsCi`) now counts, for each check name, only its latest record on the head (latest start, then completion time, then larger id). Earlier records of the same check (cancelled by a replaced run, or failed before a re-run) no longer take part. This fixes a false FAILURE on pull requests where adding `full-ci` or a re-run replaced the running CI.
- A check whose latest record is `cancelled` and has no replacement is reported as "cancelled, not a test failure": the overall conclusion is `cancelled` (neither `failure` nor `success`), the new `cancelledJobs` field lists it, and `failedJobs` is left for real `failure` / `timed_out` / `action_required`.
- A successful, not cancelled `CI result` of the head with no real failures among the latest records gives `success`.

## changelog-ru

### Проверки отменённого и заменённого прогона CI больше не делают сводку CI доски красной (CI-SNAPSHOT-CANCELLED)

- Сводка CI, которую доска отдаёт агентам (`ciResult` / `pullRequestsCi`), теперь для каждого имени проверки учитывает только последнюю запись на голове (позднее начало, затем завершение, затем больший id). Более ранние записи той же проверки (отменённые заменённым прогоном или упавшие до перезапуска) в подсчёте не участвуют. Исправляет ложный FAILURE на PR, где метка `full-ci` или перезапуск заменили идущий CI.
- Проверка, чья последняя запись `cancelled` и замены нет, показывается как «cancelled, not a test failure»: общий итог `cancelled` (не `failure` и не `success`), новое поле `cancelledJobs` перечисляет её, а `failedJobs` остаётся для настоящих `failure` / `timed_out` / `action_required`.
- Успешная неотменённая `CI result` головы без настоящих падений среди последних записей даёт `success`.
