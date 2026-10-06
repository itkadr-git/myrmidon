## changelog-en

### Run lists and the attention feed read thin run-context columns (OPE-5007 П2)

- `heartbeat_runs` gained nine nullable text columns (`context_issue_id`,
  `context_task_id`, `context_task_key`, `context_comment_id`,
  `context_wake_comment_id`, `context_wake_reason`, `context_wake_source`,
  `context_wake_trigger_detail`, `context_run_summary`) that mirror the small
  hot fields previously buried in the `context_snapshot` jsonb. The run list,
  the attention feed and the exhausted-runs query read the columns with a
  `coalesce(column, context_snapshot ->> key)` fallback, so historical rows
  keep resolving while the board's hottest queries stop detoasting dozens of
  kilobytes of snapshot per row. Migration `0307` backfills existing rows in
  primary-key batches. The `executionContinuation` envelope is no longer
  persisted into `context_snapshot` (the wake payload keeps carrying it from
  memory), which removes the largest per-run snapshot duplicate.

## changelog-ru

### Списки прогонов и attention-фид читают тонкие колонки контекста прогона (OPE-5007 П2)

- У таблицы `heartbeat_runs` появились девять nullable text-колонок
  (`context_issue_id`, `context_task_id`, `context_task_key`,
  `context_comment_id`, `context_wake_comment_id`, `context_wake_reason`,
  `context_wake_source`, `context_wake_trigger_detail`, `context_run_summary`) —
  тонкие горячие поля, которые раньше лежали внутри jsonb `context_snapshot`.
  Список прогонов, attention-фид и запрос исчерпанных прогонов читают колонки
  с фолбэком `coalesce(колонка, context_snapshot ->> ключ)`: старые строки
  продолжают резолвиться, а самые частые запросы доски перестают детостить
  десятки килобайт снапшота на строку. Миграция `0307` заполняет существующие
  строки батчами по первичному ключу. Конверт `executionContinuation` больше
  не персистится в `context_snapshot` (в payload побудки он по-прежнему
  попадает из памяти) — исчезает крупнейший дубль в снапшоте прогона.
