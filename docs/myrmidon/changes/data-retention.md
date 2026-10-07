---
divergence-section: Трек 5 — эксплуатация
settings-section: Track 5 — operations
---

## changelog-en

### Retention of runs and logs: settings, sweep and backup gate (1.6.5 DB-RETENTION, server core)

- Finished heartbeat runs, activity-log rows and access-audit rows now age
  out on a schedule. Three new instance settings —
  `instance_settings.general.dataRetention.heartbeatRunsDays`,
  `...activityLogDays` and `...accessAuditDays` — set the retention per table
  group in whole days (default 90/90/90; `0` keeps the group forever). The
  stored value is the single truth; an absent row applies the defaults.
- A retention sweep runs one pass per scheduler tick, deleting in batches of
  5000 rows (at most 100 batches per table per pass, under a 60 s statement
  timeout) so the first cleanup of a large table takes many short ticks
  instead of one long lock-holding transaction. A run is deleted only when it
  is finished, past the retention and not referenced by open work: runs of
  open issues (execution/checkout), retry parents of live runs and the
  sources of unresolved failed-run attention items survive, as do the
  activity rows of every surviving run (the audit trail stays complete). Run
  events go with their run; financial rows and decisions keep their record
  with the run reference cleared.
- The sweep never deletes without a fresh verified database backup: when the
  newest `<prefix>-*.sql.gz` in the configured backup directory is older than
  24 hours (or missing), the pass deletes nothing, writes one
  `data.retention_waiting_for_backup` activity line (at most once per hour)
  and reports `waitingForBackup` in its status; the gate lifts on the next
  pass once a fresh backup appears. The filename prefix is configurable via
  `MYRMIDON_DB_BACKUP_FILE_PREFIX` (default `paperclip`) — see
  [SETTINGS.md](../SETTINGS.md).
- `GET /api/myrmidon/data-retention` (board-readable) reports the three
  values with their source (`settings` | `default`) and the last pass
  (timestamp, per-table deleted counters, a freed-bytes lower bound, the
  backup-gate state, all persisted across restarts).
  `PATCH /api/myrmidon/data-retention` (instance-admin) changes the values;
  the sweep re-reads them at the top of every pass, so no restart is needed.
  The settings UI ships separately (part P2).

## changelog-ru

### Сроки хранения прогонов и журналов: настройки, sweep и backup-gate (1.6.5 DB-RETENTION, серверное ядро)

- Завершённые heartbeat-прогоны, строки журнала активности и записи аудита
  доступа теперь устаревают по расписанию. Три новые настройки инстанса —
  `instance_settings.general.dataRetention.heartbeatRunsDays`,
  `...activityLogDays` и `...accessAuditDays` — задают срок хранения по
  группам таблиц в целых днях (по умолчанию 90/90/90; `0` — хранить вечно).
  Сохранённое значение — единственный источник истины; при отсутствии записи
  действуют умолчания.
- Sweep делает один проход за тик планировщика, удаляя пачками по 5000 строк
  (не более 100 пачек на таблицу за проход, с `statement_timeout` 60 с), так
  что первая чистка большой таблицы занимает много коротких тиков вместо
  одной длинной транзакции с блокировками. Прогон удаляется, только если он
  завершён, старше срока хранения и не связан с открытой работой: выживают
  прогоны открытых задач (execution/checkout), родители живых повторов и
  источники незакрытых failed_run-карточек внимания; выживают и строки
  журнала каждого оставшегося прогона (аудит остаётся полным). События
  прогона удаляются вместе с ним; финансовые записи и решения сохраняются с
  очищенной ссылкой на прогон.
- Sweep не удаляет ничего без свежего проверенного бэкапа БД: если новейший
  `<prefix>-*.sql.gz` в настроенном каталоге бэкапов старше 24 часов (или
  отсутствует), проход ничего не удаляет, пишет одну строку
  `data.retention_waiting_for_backup` в журнал (не чаще раза в час) и
  показывает `waitingForBackup` в статусе; блокировка снимается на следующем
  проходе, как только появляется свежий бэкап. Префикс имени файла
  настраивается через `MYRMIDON_DB_BACKUP_FILE_PREFIX` (умолчание
  `paperclip`) — см. [SETTINGS.md](../SETTINGS.md).
- `GET /api/myrmidon/data-retention` (доступен читателю доски) отдаёт три
  значения с источником (`settings` | `default`) и состояние последнего
  прохода (время, счётчики удалённых строк по таблицам, нижняя оценка
  освобождённых байт, состояние backup-gate — всё переживает перезапуск).
  `PATCH /api/myrmidon/data-retention` (админ инстанса) меняет значения;
  sweep перечитывает их в начале каждого прохода, перезапуск не нужен.
  Интерфейс настроек выходит отдельно (часть P2).

## divergence

| 1.6.5-DB-RETENTION | Сроки хранения прогонов и журналов: настройки `instance_settings.general.dataRetention` (heartbeatRunsDays/activityLogDays/accessAuditDays, умолчание 90/90/90, 0 = хранить вечно), sweep с батчами 5000 и `statement_timeout` 60 с, backup-gate (нет свежего `<prefix>-*.sql.gz` за 24 ч — удалений нет, тротлированная строка `data.retention_waiting_for_backup`), статус в `dataRetention.lastRun`, маршруты GET/PATCH `/api/myrmidon/data-retention`. Удаление прогона чистит его `heartbeat_run_events` и обнуляет ссылки `heartbeat_run_id`/`origin_run_id`/`last_run_id` в финансовых и decision-таблицах (FK без каскада) | `server/src/app.ts`, `server/src/index.ts`, `server/src/services/instance-settings.ts`, `packages/shared/src/index.ts`, `packages/shared/src/types/instance.ts`, `packages/shared/src/validators/instance.ts` (все правки помечены `myrmidon(1.6.5-DB-RETENTION)`); новые файлы `server/src/myrmidon/data-retention/*`, `packages/shared/src/myrmidon-data-retention.ts` | Зонтик 1.6.5 (DB-PERF): база доски разрастается, нужен настраиваемый срок хранения прогонов и журналов с защитой свежим бэкапом | `server/src/myrmidon/data-retention/sweep.myrmidon.test.ts`, `server/src/myrmidon/data-retention/service.myrmidon.test.ts` | Никогда, наше поведение: сроки хранения живут в настройках инстанса; если вендор получит свою ретенцию прогонов — удалить куски `myrmidon(1.6.5-DB-RETENTION)` и переписать тесты на поведение вендора | (этот PR) |

## settings-en

| `dataRetention.heartbeatRunsDays` | 1.6.5-DB-RETENTION | 90 | Retention of finished heartbeat runs (with their run events) in whole days; runs referenced by open work (open issues, retry parents of live runs, unresolved failed-run attention sources) are kept regardless of age | Set to `0` to keep runs forever; changed from `PATCH /api/myrmidon/data-retention` |
| `dataRetention.activityLogDays` | 1.6.5-DB-RETENTION | 90 | Retention of activity-log rows in whole days; rows of a surviving run are kept so its audit trail stays complete | Set to `0` to keep the activity log forever |
| `dataRetention.accessAuditDays` | 1.6.5-DB-RETENTION | 90 | Retention of tool-access audit events and secret access events in whole days | Set to `0` to keep the access audit forever |

## settings-ru

| `dataRetention.heartbeatRunsDays` | 1.6.5-DB-RETENTION | 90 | Срок хранения завершённых heartbeat-прогонов (вместе с событиями прогона) в целых днях; прогоны, связанные с открытой работой (открытые задачи, родители живых повторов, незакрытые failed_run-карточки внимания), хранятся независимо от возраста | `0` — хранить прогоны вечно; меняется через `PATCH /api/myrmidon/data-retention` |
| `dataRetention.activityLogDays` | 1.6.5-DB-RETENTION | 90 | Срок хранения строк журнала активности в целых днях; строки выжившего прогона сохраняются, чтобы его аудит оставался полным | `0` — хранить журнал вечно |
| `dataRetention.accessAuditDays` | 1.6.5-DB-RETENTION | 90 | Срок хранения записей аудита доступа к инструментам и секретам в целых днях | `0` — хранить аудит доступа вечно |
