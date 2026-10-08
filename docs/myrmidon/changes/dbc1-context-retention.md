---
divergence-section: Трек 5 — эксплуатация
settings-section: Track 5 — operations
---

## changelog-en

### Run-context retention: heartbeat_runs context compaction as a board function (1.6.5-DBC1)

- The bulky continuation payloads of finished runs (`executionContinuation`,
  `paperclipWake`, `paperclipTaskMarkdown`/`…Compact`,
  `paperclipWakeComment`, `paperclipSessionHandoffMarkdown`,
  `paperclipContinuationSummary`, `externalChatContinuation` — the O1a key
  list) are now compacted out of `heartbeat_runs.context_snapshot` by the
  board itself: every terminal run older than
  `instance_settings.general.datastoreCare.retention.heartbeatRunContextDays`
  (env `PAPERCLIP_HEARTBEAT_RUN_CONTEXT_RETENTION_DAYS`, default 7 days, 0 =
  disabled) has those keys stripped and `_compactedAt` stamped in its
  snapshot. Small keys (taskKey, issueId, wakeReason) survive; attention-feed
  derivations and audit queries keep working. Compaction is a rewrite, not a
  row delete.
- The compaction runs on the maintenance sweep tick under the maintenance
  gate (it does nothing while an instance window is open), in batches of 500
  rows per statement with a 250 ms pause between batches and a 30 s
  statement timeout per batch, and only when the backup precondition holds:
  the newest `<prefix>-*.sql.gz` in the configured backup dir must be under
  24 hours old. Without a fresh backup the pass rewrites nothing and logs one
  throttled `datastore.retention_waiting_for_backup` line (at most once per
  hour).
- Each pass writes one `datastore.retention_applied` activity line per
  company that had work, carrying `compactedRows` and `freedBytes` (the exact
  `pg_column_size` delta of the rewritten snapshots), and persists its state
  in `general.datastoreCare.retention.contextLastRun`, so the counters survive
  restarts.
- `GET /api/myrmidon/datastore-care` (board-readable) reports the resolved
  window with its source (`settings` | `env` | `default`) and the last pass;
  `PATCH /api/myrmidon/datastore-care` (instance-admin) changes the window —
  the sweep re-reads it every pass, no restart needed. The retention
  sub-block is the same `datastoreCare` block the row-deletion limits
  (OPE-5011) live in, so the UI shows one "Storage" panel. The settings UI
  ships separately.
- With the board compaction live, the host-side O1b cron job becomes
  redundant and must be removed at rollout (recorded in the deploy repo, not
  here).

## changelog-ru

### Хранение контекста прогонов: компакт context_snapshot как функция доски (1.6.5-DBC1)

- Громоздкие блоки продолжения контекста завершённых прогонов (`executionContinuation`,
  `paperclipWake`, `paperclipTaskMarkdown`/`…Compact`, `paperclipWakeComment`,
  `paperclipSessionHandoffMarkdown`, `paperclipContinuationSummary`,
  `externalChatContinuation` — список ключей O1a) теперь компактируются из
  `heartbeat_runs.context_snapshot` самой доской: у каждого терминального
  прогона, созданного раньше срока `instance_settings.general.datastoreCare.retention.heartbeatRunContextDays`
  (env `PAPERCLIP_HEARTBEAT_RUN_CONTEXT_RETENTION_DAYS`, умолчание 7 суток,
  0 = выключено) эти ключи вычищаются, а в снимок ставится отметка
  `_compactedAt`. Мелкие ключи (taskKey, issueId, wakeReason) сохраняются —
  производные ленты внимания и аудиторные запросы продолжают работать.
  Компакт — перезапись строк, а не удаление.
- Уплотнение идёт на тике свипа обслуживания под гейтом обслуживания (при
  открытом окне инстанса проход ничего не делает), пачками по 500 строк на
  запрос с паузой 250 мс между пачками и `statement_timeout` 30 с на пачку, и
  только при свежем бэкапе: новый `<prefix>-*.sql.gz` в настроенном каталоге
  бэкапов не старше 24 часов. Без свежего бэкапа проход ничего не переписывает
  и пишет одну троттленную строку `datastore.retention_waiting_for_backup`
  (не чаще раза в час).
- Каждый проход с работой пишет по строке `datastore.retention_applied` в
  `activity_log` на компанию с числом `compactedRows` и `freedBytes` (точный
  дельта `pg_column_size` перезаписанных снапшотов) и сохраняет состояние в
  `general.datastoreCare.retention.contextLastRun` — счётчики переживают перезапуск.
- `GET /api/myrmidon/datastore-care` (читает любая доска) показывает срок с
  источником (`settings` | `env` | `default`) и последний проход;
  `PATCH /api/myrmidon/datastore-care` (админ инстанса) меняет срок — свип
  перечитывает его каждый проход, перезапуск не нужен. Подблок retention
  лежит в том же блоке `datastoreCare`, где сроки удаления строк (OPE-5011),
  чтобы в интерфейсе была одна панель «Хранение». Экран настроек едет
  отдельной частью.
- С живой компакт-функцией доски хостовый cron O1б избыточен и снимается при
  выкате (фиксируется в деплой-репозитории, не здесь).

## divergence

| DBC-1 | Уплотнение контекста прогонов в таблице `heartbeat_runs` как функция доски: гейт обслуживания + предусловие «бэкап свеж» + пакетный UPDATE `context_snapshot` на тике свипа | `server/src/services/instance-settings.ts` (`updateGeneral` preserve + normalize-keep), `packages/shared/src/validators/instance.ts` (general `datastoreCare`) | Контекст прогонов — самый тяжёлый JSONB в таблице; без компакта старый O1a-цикл жил хостовым cron вне доски (решение владельца 08.10: оптимизация хранилищ — функция доски) | `server/src/myrmidon/datastore-care/retention/retention.myrmidon.test.ts` (чистые правила), `compact.db.myrmidon.test.ts` (embedded-postgres: терминальные старые уплотняются, живые/свежие/без ключей — нет, идемпотентность) | Уплотнение выключается значением 0 в `general.datastoreCare.retention.heartbeatRunContextDays` | — |

## settings-en

| `PAPERCLIP_HEARTBEAT_RUN_CONTEXT_RETENTION_DAYS` | DBC-1 | 7 | Whole days after a terminal run's `created_at` before its `context_snapshot` is compacted (O1a key list stripped, `_compactedAt` stamped); overridden by `general.datastoreCare.retention.heartbeatRunContextDays`, `0` disables the compaction | Set `general.datastoreCare.retention.heartbeatRunContextDays: 0` via `PATCH /api/myrmidon/datastore-care` |
| `MYRMIDON_DB_BACKUP_FILE_PREFIX` | DBC-1 | paperclip | Filename prefix of the database backups the retention backup gate looks for (`<prefix>-*.sql.gz`, younger than 24 h); the same knob `runDatabaseBackup` writes under | Unset it to fall back to `paperclip`; disable the compaction entirely with `heartbeatRunContextDays: 0` |

## settings-ru

| `PAPERCLIP_HEARTBEAT_RUN_CONTEXT_RETENTION_DAYS` | DBC-1 | 7 | Целые сутки после `created_at` терминального прогона, по истечении которых `context_snapshot` уплотняется (ключи O1a вычищаются, ставится отметка `_compactedAt`); перекрывается `general.datastoreCare.retention.heartbeatRunContextDays`, `0` выключает компакт | `PATCH /api/myrmidon/datastore-care`, `heartbeatRunContextDays: 0` |
