## changelog-en

### `myrmidon:migrate` preserves `resource_lifecycle_events` in `activity_log` (OPE-11642)

- Vendor lifecycle events from `resource_lifecycle_events` are now preserved during
  migration from the vendor instead of being excluded as vendor-only data.
- The events are mapped into `activity_log` as project lifecycle events with corresponding actions
  (`project.created`, `project.updated`, `project.deleted`), preserving project associations, entity
  identifiers, and event counts without creating a new table.
- Importing datasets with `resource_lifecycle_events` no longer requires `--accept-vendor-only-data`.

## changelog-ru

### `myrmidon:migrate` переносит `resource_lifecycle_events` в `activity_log` (OPE-11642)

- События жизненного цикла из таблицы вендора `resource_lifecycle_events` теперь переносятся при
  миграции из вендора вместо исключения как vendor-only данные.
- События маппятся в таблицу `activity_log` как события жизненного цикла проектов с соответствующими
  действиями (`project.created`, `project.updated`, `project.deleted`), сохраняя привязку к проектам,
  идентификаторы сущностей и общее количество событий без создания новой таблицы.
- Для импорта данных с `resource_lifecycle_events` больше не требуется флаг `--accept-vendor-only-data`.
