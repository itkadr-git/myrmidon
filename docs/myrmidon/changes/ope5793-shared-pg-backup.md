---
divergence-section: Трек 5 — эксплуатация
settings-section: Track 5 — operations
---

## changelog-en

### Database backups work against a shared PostgreSQL 18 server (1.6.5 SHARED-PG-BACKUP)

- The board's dump path never shells into a container: `runDatabaseBackup`
  dumps exactly the database and role of the configured connection string
  (`DATABASE_URL` / `config.database.connectionString`), with the host's
  `pg_dump` as a plain client binary. No code or packaging reference to
  `paperclip-db-1` / the compose database service remains in `packages/db` or
  `cli`.
- Before the first dump row is read, the pg_dump engine now compares the
  client major (`pg_dump --version`) with the server major (`SELECT
  version()`). A client older than the server — the pg_dump 17 vs PostgreSQL
  18 case, where libpq refuses with a raw "server version X is newer than
  client version Y" mid-spawn — is diagnosed up front: `backupEngine:
  "pg_dump"` fails immediately with `BackupClientVersionError` naming the
  fix, and `backupEngine: "auto"` (the scheduled default) warns and falls
  back to the JavaScript dump, which streams the same tables over the already
  compatible wire protocol and always produces a backup.
- The warning travels to operators: `RunDatabaseBackupResult.warnings`, the
  one-line `formatDatabaseBackupResult` summary, the CLI `db:backup` output
  and its `--json` payload, and the scheduled-backup logger.
- The dump client is configured, not assumed: `PAPERCLIP_PG_DUMP_PATH` points
  the engine at a client of the server's major or newer (e.g. the PGDG 18
  `pg_dump` on a board host whose distro still ships client 17); the same
  idea for the restore path via `PAPERCLIP_PSQL_PATH`. Both were already read
  by the engine; the compatibility check is what makes setting them
  observable instead of trial-and-error.

## changelog-ru

### Бэкап базы работает с общим сервером PostgreSQL 18 (1.6.5 SHARED-PG-BACKUP)

- Путь дампа больше не заходит ни в какой контейнер: `runDatabaseBackup`
  дампит ровно ту базу и роль, что заданы конфигурационной строкой
  подключения (`DATABASE_URL` / `config.database.connectionString`), клиент-
  бинарником `pg_dump` на хосте. В `packages/db` и `cli` не осталось ссылок
  на `paperclip-db-1` и сервис БД compose-файла.
- До первой прочитанной строки дампа движок сверяет major клиента
  (`pg_dump --version`) с major сервера (`SELECT version()`). Клиент старше
  сервера — случай pg_dump 17 против PostgreSQL 18, где libpq отказывает с
  сырым «server version X is newer than client version Y» посреди spawn, —
  диагностируется заранее: `backupEngine: "pg_dump"` падает сразу с
  `BackupClientVersionError` и понятной лечебной строкой, а `backupEngine:
  "auto"` (дефолт планировщика) предупреждает и дампит JavaScript-путём,
  который читает те же таблицы по совместимому wire-протоколу и всегда даёт
  бэкап.
- Предупреждение доходит до оператора: `RunDatabaseBackupResult.warnings`,
  однострочная сводка `formatDatabaseBackupResult`, вывод `cli db:backup` и
  его `--json`, и лог планового бэкапа.
- Клиент задаётся конфигурацией, а не угадывается: `PAPERCLIP_PG_DUMP_PATH`
  указывает движку клиент major сервера или новее (например PGDG-`pg_dump`
  18 на хосте, где дистрибутив ещё даёт клиент 17); для восстановления —
  `PAPERCLIP_PSQL_PATH`. Оба движок читал и раньше; проверка совместимости
  делает их настройку наблюдаемой, а не методом проб.

## divergence

| SHARED-PG-BACKUP | Перед дампом pg_dump движок бэкапа сверяет major клиента (`pg_dump --version`) с major сервера (`SELECT version()` по уже открытому соединению бэкапа): явный `backupEngine: "pg_dump"` при клиенте старше сервера падает сразу с `BackupClientVersionError` и лечебной строкой про `PAPERCLIP_PG_DUMP_PATH`, `auto` предупреждает (`RunDatabaseBackupResult.warnings`) и продолжает JavaScript-дамп-путём; предупреждения печатаются в сводке `formatDatabaseBackupResult`, в выводе и `--json` команды `cli db:backup`; ни в коде, ни в упаковке пути бэкапа нет ссылки на контейнер БД (`paperclip-db-1`/compose) — дамп идёт клиент-бинарником по `connectionString` самой доски | `packages/db/src/backup-lib.ts`, `packages/db/src/index.ts`, `cli/src/commands/db-backup.ts` | Решение владельца 07.10: база доски переезжает на общий сервер PostgreSQL 18 (LiteLLM/Langfuse/Hindsight там же); вендорский путь дампа падает на клиенте 17 посреди spawn сырым libpq-сообщением, плановые бэкапы на таком сервере падали бы без понятной диагностики | `packages/db/src/backup-shared-pg.myrmidon.test.ts` (unit + embedded-18 кейсы: явный engine red, auto green с warning), `cli/src/__tests__/db-backup-command.test.ts` (connectionString из конфигурации, warnings в выводе) | При переносе вендорского backup-lib: перенести куски с меткой `myrmidon(SHARED-PG-BACKUP)` (pure-хелперы `parsePgMajorVersion`/`diagnosePgDumpClient`, gate в pg_dump-ветке `runDatabaseBackup`, `warnings` в результате); если вендор сам начнёт сверять версии — удалить хелперы, ошибку и тест-сторож | (этот PR) |

## settings-en

| `PAPERCLIP_PG_DUMP_PATH` | SHARED-PG-BACKUP | `pg_dump` (в `PATH`) | Путь к клиент-бинарнику `pg_dump` для движка бэкапа; на общем сервере 18 укажи клиент major 18+ — иначе плановый `auto` бэкап предупреждает и дампит JavaScript-путём | Не задана — клиент из `PATH`; поведение до 1.6.5, если клиент не старше сервера |
| `PAPERCLIP_PSQL_PATH` | SHARED-PG-BACKUP | `psql` (в `PATH`) | Путь к `psql` для восстановления бэкапа; при общем сервере 18 — клиент major 18+ | Не задана — `psql` из `PATH` |

## settings-ru

| `PAPERCLIP_PG_DUMP_PATH` | SHARED-PG-BACKUP | `pg_dump` (в `PATH`) | Путь к клиент-бинарнику `pg_dump` для движка бэкапа; на общем сервере 18 укажи клиент major 18+ — иначе плановый `auto` бэкап предупреждает и дампит JavaScript-путём | Не задана — клиент из `PATH`; поведение до 1.6.5, если клиент не старше сервера |
| `PAPERCLIP_PSQL_PATH` | SHARED-PG-BACKUP | `psql` (в `PATH`) | Путь к `psql` для восстановления бэкапа; при общем сервере 18 — клиент major 18+ | Не задана — `psql` из `PATH` |
