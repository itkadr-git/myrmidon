---
settings-section: Track 5 — operations
---

## changelog-en

### Context compaction: per-pass batch ceiling as a live setting; the backup-source contract written down (1.6.5-F14B)

- The compaction pass's ceiling `CONTEXT_COMPACT_MAX_BATCHES` (batches of 500
  rows per company per pass) is no longer a build-time constant: the pass
  resolves `general.datastoreCare.retention.contextCompactMaxBatches` first,
  then the `MYRMIDON_CONTEXT_COMPACT_MAX_BATCHES` environment override, then
  the default of 10, and re-reads it every pass — so the first live passes on
  an IO-starved board are throttled with a `PATCH /api/myrmidon/datastore-care`
  without a rebuild or restart. `GET /api/myrmidon/datastore-care` reports the
  ceiling with its source (`settings` | `env` | `default`).
- The agreed backup source of the retention gate is documented as a contract:
  the board's built-in DB Backup is the primary fresh-backup producer, a
  host-side `pg_dump -Fc` dump (`*.dump`) is accepted by extension as a
  fallback intended for shipping to external storage, and with an empty
  prefix any `*.sql.gz`/`*.dump` in the dir counts (non-matching names are
  still reported as `candidates`).
- The gate's contract is pinned by tests: a failed freshness check against an
  embedded Postgres still writes the full `contextLastRun.backupGate` report
  with honest field names and `waitingForBackup: true`, while the legacy trap
  field `backupCheckedAt` keeps its meaning (newest backup mtime, not check
  time) — it is deliberately not renamed (state migration).

## changelog-ru

### Уплотнение контекста: потолок пачек за проход — живая настройка; договор источника бэкапа записан (1.6.5-F14B)

- Потолок `CONTEXT_COMPACT_MAX_BATCHES` (пачек по 500 строк на компанию за
  проход) больше не константа сборки: проход разрешает
  `general.datastoreCare.retention.contextCompactMaxBatches`, затем окружение
  `MYRMIDON_CONTEXT_COMPACT_MAX_BATCHES`, затем умолчание 10, и перечитывает
  его каждый проход — первые живые проходы на бою с IO-голодом приземляются
  `PATCH /api/myrmidon/datastore-care` без пересборки и перезапуска.
  `GET /api/myrmidon/datastore-care` показывает потолок с источником
  (`settings` | `env` | `default`).
- Согласованный источник «свежего бэкапа» для гейта записан договором:
  основной — встроенный бэкап доски; хостовый дамп `pg_dump -Fc` (`*.dump`)
  принимается по расширению как резервный, предназначенный для выгрузки во
  внешнее хранилище; при пустом префиксе считается любой `*.sql.gz`/`*.dump`
  в каталоге (неподходящие по префиксу имена по-прежнему видны в
  `candidates`).
- Договор гейта закреплён тестами: отказ проверки свежести на embedded
  Postgres всё равно пишет полный отчёт `contextLastRun.backupGate` с
  честными именами полей и `waitingForBackup: true`, а поле-обманка
  `backupCheckedAt` сохраняет смысл (mtime свежайшего бэкапа, а не время
  проверки) — намеренно не переименовано (миграция состояния).

## settings-en-new

<!-- after: Track 2 — wake and run core -->
### 1.6.5 F14 — the backup source contract of the retention gate

The compaction gate treats as "a fresh backup" what it finds in the configured
backup directory (`database.backup.dir` in the instance config, otherwise the
instance default `<instance data dir>/backups`):

- agreed primary source — the board's built-in DB Backup: with `DB Backup`
  enabled (every 360 min on the board) `runDatabaseBackup` writes
  `<instance>/data/backups/<prefix>-*.sql.gz`, and the gate matches exactly
  those files by the `MYRMIDON_DB_BACKUP_FILE_PREFIX` prefix;
- fallback — a host-side `pg_dump -Fc` dump dropped into the same directory
  with the `*.dump` extension: accepted by extension, newest by mtime. It is
  intended for shipping to external storage; the gate only reads its age;
- with an empty prefix any `*.sql.gz`/`*.dump` in the directory counts,
  newest first; files of those extensions that do not match the prefix are
  reported as `candidates` in the persisted gate state, so a stall caused by
  a wrong prefix stays diagnosable.

The per-pass batches ceiling resolves instance setting > environment >
default and is re-read on every pass (a PATCH applies without restart):

| Variable / setting | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_CONTEXT_COMPACT_MAX_BATCHES` / `general.datastoreCare.retention.contextCompactMaxBatches` | F14 | `10` | Batches of 500 rows per company per compaction pass; the rest of the backlog waits for the next sweep tick. The first live passes on an IO-starved board lower the ceiling without a rebuild | Setting (1..1000) wins over the environment; unset/invalid falls to `10`. `GET /api/myrmidon/datastore-care` reports the resolved value and its source (`settings` \| `env` \| `default`); change it with `PATCH /api/myrmidon/datastore-care` (instance admin) |

## settings-ru-new

<!-- after: Трек 2 — ядро побудок и прогонов -->
### 1.6.5 F14 — договор источника бэкапа для гейта ретеншна

Гейт компакт-прохода считает «свежим бэкапом» то, что находит в настроенном
каталоге бэкапов (`database.backup.dir` в конфиге инстанса, иначе каталог по
умолчанию `<данные инстанса>/backups`):

- согласованный основной источник — встроенный бэкап доски: при включённом
  `DB Backup` (на бою — каждые 360 мин) `runDatabaseBackup` пишет
  `<instance>/data/backups/<prefix>-*.sql.gz`, и гейт ищет ровно эти файлы
  по префиксу `MYRMIDON_DB_BACKUP_FILE_PREFIX`;
- резервный — хостовый дамп `pg_dump -Fc`, уложенный в тот же каталог с
  расширением `*.dump`: принимается по расширению, свежайший по mtime. Он
  предназначен для выгрузки во внешнее хранилище; гейт читает только его
  возраст;
- при пустом префиксе считается любой `*.sql.gz`/`*.dump` в каталоге,
  свежайший первым; файлы этих расширений не по префиксу попадают в
  `candidates` persisted-состояния гейта, чтобы застревание из-за неверного
  префикса оставалось диагностируемым.

Потолок пачек за проход разрешается по цепочке настройка инстанса > окружение
> умолчание и перечитывается каждый проход (PATCH применяется без
перезапуска):

| Переменная / настройка | Функция | По умолчанию | Что делает | Как выключить / особое |
|---|---|---|---|---|
| `MYRMIDON_CONTEXT_COMPACT_MAX_BATCHES` / `general.datastoreCare.retention.contextCompactMaxBatches` | F14 | `10` | Сколько пачек по 500 строк на компанию делает один компакт-проход; остаток очереди ждёт следующего тика свипа. Первые живые проходы на бою с IO-голодом снижают потолок настройкой инстанса без пересборки | Настройка (1..1000) важнее окружения; не задана/некорректна — `10`. `GET /api/myrmidon/datastore-care` показывает разрешённое значение и источник (`settings` \| `env` \| `default`); менять — `PATCH /api/myrmidon/datastore-care` (админ инстанса) |
