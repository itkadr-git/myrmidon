---
divergence-section: Трек 5 — эксплуатация
settings-section: Track 5 — operations
---

## changelog-en

### Retention of runs and logs: settings, sweep and backup gate (1.6.5 DB-RETENTION, server core)

- Finished heartbeat runs and access-audit rows now age out on a schedule
  (the activity log is the audit trail and is kept forever by default —
  `activityLogDays: 0` — until the instance admin opts into a limit). Three
  new instance settings —
  `instance_settings.general.datastoreCare.retention.heartbeatRunsDays`,
  `...activityLogDays` and `...accessAuditDays` — set the retention per table
  group in whole days (defaults: runs 90, activity log 0 = kept forever — it
  is the audit trail, access audit 180; `0` keeps the group forever). The
  settings live in the datastore-care object of the §3.6 "Хранение" panel
  (`general.datastoreCare.retention`); the stored value is the single truth,
  an absent row applies the defaults.
- A retention sweep runs at most one pass per 10 minutes (the 30 s scheduler
  tick no-ops in between), deleting in batches of 5000 rows (at most 100
  batches per table per pass, under a 60 s statement timeout) — every batch
  is its own transaction, so a failed batch rolls back only itself, and a
  batch that hits the timeout writes one `data.retention_sweep_throttled`
  activity line instead of being swallowed silently. The sweep state
  (`lastRun`) is written only when a pass actually deleted something or the
  backup-gate flag changes — not on every idle tick. A run is deleted only
  when it is finished, past the retention and not referenced by open work:
  runs of open issues (execution/checkout), retry parents of live runs and
  the sources of unresolved failed-run attention items survive, as do the
  activity rows of every surviving run (the audit trail stays complete). A
  run referenced by any decision-making or native completion record
  (decisions, decision bundles, status decisions, work assessments, native
  run results) is never deleted — those records outlive the run. Run events
  go with their run; financial rows keep their record with the run reference
  cleared.
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

- Завершённые heartbeat-прогоны и записи аудита доступа теперь устаревают
  по расписанию (журнал активности — это аудит-трейл, по умолчанию хранится
  вечно: `activityLogDays: 0` — пока админ инстанса не задаст срок). Три
  новые настройки инстанса —
  `instance_settings.general.datastoreCare.retention.heartbeatRunsDays`,
  `...activityLogDays` и `...accessAuditDays` — задают срок хранения по
  группам таблиц в целых днях (умолчания: прогоны 90, журнал активности 0 =
  хранится вечно — это аудит-трейл, аудит доступа 180; `0` — хранить вечно).
  Настройки живут в datastore-care объекте панели «Хранение» §3.6
  (`general.datastoreCare.retention`); сохранённое значение — единственный
  источник истины, при отсутствии записи действуют умолчания.
- Sweep делает не более одного прохода в 10 минут (тик планировщика 30 с
  между проходами — холостой), удаляя пачками по 5000 строк (не более 100
  пачек на таблицу за проход, с `statement_timeout` 60 с) — каждая пачка в
  своей транзакции, так что упавшая пачка откатывает только себя, а пачка,
  упёршаяся в таймаут, пишет одну строку `data.retention_sweep_throttled` в
  журнал вместо тихого проглатывания. Состояние sweep (`lastRun`) пишется,
  только когда проход реально что-то удалил или сменился флаг backup-gate —
  не на каждом холостом тике. Прогон удаляется, только если он завершён,
  старше срока хранения и не связан с открытой работой: выживают прогоны
  открытых задач (execution/checkout), родители живых повторов и источники
  незакрытых failed_run-карточек внимания; выживают и строки журнала каждого
  оставшегося прогона (аудит остаётся полным). Прогон, на который ссылается
  любая запись принятия решений или нативного завершения (решения, бандлы
  решений, решения по статусам, оценки работ, результаты нативных прогонов),
  не удаляется никогда — эти записи переживают прогон. События прогона
  удаляются вместе с ним; финансовые записи сохраняются с очищенной ссылкой
  на прогон.
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

| 1.6.5-DB-RETENTION | Сроки хранения прогонов и журналов: настройки `instance_settings.general.datastoreCare.retention` (heartbeatRunsDays/activityLogDays/accessAuditDays, умолчания 90/0/180 — журнал активности по умолчанию не удаляется, 0 = хранить вечно), sweep с батчами 5000 (каждый в своей транзакции) и `statement_timeout` 60 с, не чаще прохода в 10 мин, таймаут батча пишет `data.retention_sweep_throttled`, backup-gate (нет свежего `<prefix>-*.sql.gz` за 24 ч — удалений нет, тротлированная строка `data.retention_waiting_for_backup`), статус в `datastoreCare.retention.lastRun` (пишется только при фактической работе), маршруты GET/PATCH `/api/myrmidon/data-retention`. Удаление прогона чистит его `heartbeat_run_events` и обнуляет ссылки `heartbeat_run_id`/`origin_run_id`/`last_run_id` в финансовых и decision-таблицах (FK без каскада); прогон, на который ссылаются decisions/decision_bundles/status_decisions/work_assessments/native_run_results, не удаляется; строки `activity_log` прогона не удаляются — ссылка `run_id` обнуляется | `server/src/app.ts`, `server/src/index.ts`, `server/src/services/instance-settings.ts`, `packages/shared/src/index.ts`, `packages/shared/src/types/instance.ts`, `packages/shared/src/validators/instance.ts` (все правки помечены `myrmidon(1.6.5-DB-RETENTION)`); новые файлы `server/src/myrmidon/data-retention/*`, `packages/shared/src/myrmidon-data-retention.ts` | Зонтик 1.6.5 (DB-PERF): база доски разрастается, нужен настраиваемый срок хранения прогонов и журналов с защитой свежим бэкапом | `server/src/myrmidon/data-retention/sweep.myrmidon.test.ts`, `server/src/myrmidon/data-retention/service.myrmidon.test.ts` | Никогда, наше поведение: сроки хранения живут в настройках инстанса; если вендор получит свою ретенцию прогонов — удалить куски `myrmidon(1.6.5-DB-RETENTION)` и переписать тесты на поведение вендора | (этот PR) |

## settings-en

| `datastoreCare.retention.heartbeatRunsDays` | 1.6.5-DB-RETENTION | 90 | Retention of finished heartbeat runs (with their run events) in whole days; runs referenced by open work (open issues, retry parents of live runs, unresolved failed-run attention sources) or by any decision-making/native completion record (decisions, decision bundles, status decisions, work assessments, native run results) are kept regardless of age | Set to `0` to keep runs forever; changed from `PATCH /api/myrmidon/data-retention` |
| `datastoreCare.retention.activityLogDays` | 1.6.5-DB-RETENTION | 0 | Retention of activity-log rows in whole days; rows of a surviving run are kept so its audit trail stays complete | Set to `0` to keep the activity log forever |
| `datastoreCare.retention.accessAuditDays` | 1.6.5-DB-RETENTION | 180 | Retention of tool-access audit events and secret access events in whole days | Set to `0` to keep the access audit forever |
| `MYRMIDON_DB_BACKUP_FILE_PREFIX` | 1.6.5-DB-RETENTION | `paperclip` | The filename prefix the backup gate looks for: a backup counts as fresh only when the newest `<prefix>-*.sql.gz` in the configured backup directory is younger than 24 h; otherwise the sweep deletes nothing and writes a throttled `data.retention_waiting_for_backup` activity line | Unset or empty — the default `paperclip`. Set it to match the prefix of the dump tool that actually writes into the backup directory |

## settings-ru

| `datastoreCare.retention.heartbeatRunsDays` | 1.6.5-DB-RETENTION | 90 | Срок хранения завершённых heartbeat-прогонов (вместе с событиями прогона) в целых днях; прогоны, связанные с открытой работой (открытые задачи, родители живых повторов, незакрытые failed_run-карточки внимания) или с записями принятия решений/нативного завершения (решения, бандлы, решения по статусам, оценки работ, результаты нативных прогонов), хранятся независимо от возраста | `0` — хранить прогоны вечно; меняется через `PATCH /api/myrmidon/data-retention` |
| `datastoreCare.retention.activityLogDays` | 1.6.5-DB-RETENTION | 0 | Срок хранения строк журнала активности в целых днях; строки выжившего прогона сохраняются, чтобы его аудит оставался полным | `0` — хранить журнал вечно |
| `datastoreCare.retention.accessAuditDays` | 1.6.5-DB-RETENTION | 180 | Срок хранения записей аудита доступа к инструментам и секретам в целых днях | `0` — хранить аудит доступа вечно |
| `MYRMIDON_DB_BACKUP_FILE_PREFIX` | 1.6.5-DB-RETENTION | `paperclip` | Префикс имён файлов дампов, который ищет backup-gate: бэкап считается свежим, только если новейший `<prefix>-*.sql.gz` в настроенном каталоге младше 24 ч; иначе sweep ничего не удаляет и пишет тротлированную строку `data.retention_waiting_for_backup` | Пусто или не задано — умолчание `paperclip`. Укажите префикс того дампера, который реально пишет в каталог бэкапов |
