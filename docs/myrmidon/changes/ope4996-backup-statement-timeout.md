---
divergence-section: Трек 5 — эксплуатация
---

## changelog-en

### Database backup and restore sessions ignore the database-level statement_timeout (1.6.5 BACKUP-STATEMENT-TIMEOUT)

- Automatic database backups failed on stand Postgres instances that set a
  database-wide `statement_timeout` (the live board ran 120 s): the long
  `COPY ... TO STDOUT` of a big table was cancelled mid-dump with
  PostgresError 57014 and the run lost its dump.
- Every connection the backup and the restore open now sets session
  `statement_timeout = 0` (postgres.js startup parameter, and
  `PGOPTIONS=-c statement_timeout=0` for the spawned pg_dump/psql children),
  so a dump or a restore can never be cut short by the database default. A
  startup-packet/session value overrides `ALTER DATABASE ... SET`, while all
  other board connections keep the database limit unchanged.
- The override is scoped to `packages/db/src/backup-lib.ts` only: backup and
  restore are the sole users of `backupClientOptions` / the PGOPTIONS env. No
  app or migration connection is affected.

## changelog-ru

### Сессии бэкапа и восстановления БД не подчиняются базовому statement_timeout (1.6.5 BACKUP-STATEMENT-TIMEOUT)

- Автоматический бэкап базы падал на стендах Postgres с базовым
  `statement_timeout` (бой: 120 с): длинный `COPY ... TO STDOUT` по большой
  таблице прерывался в середине дампа с PostgresError 57014, прогон терял
  дамп.
- Все соединения, которые открывают бэкап и восстановление, теперь ставят
  сессионный `statement_timeout = 0` (параметр startup-packet postgres.js и
  `PGOPTIONS=-c statement_timeout=0` для spawn-ов pg_dump/psql), поэтому ни
  дамп, ни восстановление не могут быть обрезаны базовым лимитом. Значение,
  переданное при подключении, побеждает `ALTER DATABASE ... SET`, а остальные
  соединения доски сохраняют лимит без изменений.
- Переопределение ограничено файлом `packages/db/src/backup-lib.ts`:
  `backupClientOptions` / PGOPTIONS используют только бэкап и восстановление.
  Прикладные соединения и миграции не затронуты.

## divergence

| 1.6.5-BACKUP-STATEMENT-TIMEOUT | Все соединения бэкапа/восстановления БД открываются с сессионным `statement_timeout = 0`: обёртка `backupClientOptions(connectTimeout)` (`connection: { statement_timeout: "0" }` — строкой, числовое `0` postgres.js отбрасывает как falsy при сборке startup-packet) применяется во всех четырёх `postgres(...)` файла, а spawn-ы pg_dump и psql получают `PGOPTIONS=-c statement_timeout=0`; поведение остальных соединений не меняется | `packages/db/src/backup-lib.ts` (все правки помечены `myrmidon(OPE-4996)`) | Базовый `statement_timeout` стенда (бой: 120 с) обрывал длинный `COPY ... TO STDOUT` бэкапа с PostgresError 57014 (OPE-4996): дамп терялся на каждом ночном прогоне | `packages/db/src/backup-statement-timeout.myrmidon.test.ts` (COPY/JS/pg_dump-env/psql-env кейсы красны на коде вендора) | Никогда, наше поведение: если вендор сам снимет таймаут в сессиях бэкапа — удалить `backupClientOptions`/`backupPgOptions` с метками `myrmidon(OPE-4996)`, вернуть `{ max: 1, connect_timeout }` в четырёх вызовах `postgres(...)`, убрать PGOPTIONS из env spawn-ов и удалить тест-сторож | (этот PR) |
