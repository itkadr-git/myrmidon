---
settings-section: Track 5 — operations
---

## changelog-en

### Board database on a shared PostgreSQL 18 server

- Installation and Upgrading-and-rollback wiki pages document running the
  board's database on a shared PostgreSQL 18 server (pgvector, a dedicated
  database and role per program): connecting the installer to an external
  server through its database-address parameter, the `DATABASE_URL`-based
  `DUMP_COMMAND` /
  `RESTORE_COMMAND` shape for backups and rollback, the PostgreSQL 18 client
  requirement for `pg_dump`, and `MYRMIDON_PREDEPLOY_POSTGRES_IMAGE` for the
  predeploy check. Moving an existing production database to the shared
  server is the operator's one-time zero-downtime task (logical
  replication), outside the scripts.

## changelog-ru

### База доски на общем сервере PostgreSQL 18

- Страницы вики «Установка» и «Обновление и откат» описывают работу базы
  доски на общем сервере PostgreSQL 18 (pgvector, отдельная база и роль для
  каждой программы): подключение установщика к внешнему серверу через
  параметр адреса базы, форму
  `DUMP_COMMAND` / `RESTORE_COMMAND` через `DATABASE_URL` для резервных
  копий и отката, требование клиента PostgreSQL 18 для `pg_dump` и
  `MYRMIDON_PREDEPLOY_POSTGRES_IMAGE` для проверки перед выкатом. Перенос
  существующей боевой базы на общий сервер — разовая задача оператора без
  простоя (логическая репликация), вне объёма скриптов.

## settings-en

| `DATABASE_URL` | SHARED-PG | unset | board database connection string; set by the installer or by hand, anchors the shared-PostgreSQL `DUMP_COMMAND` / `RESTORE_COMMAND` shape | keep the default container-embedded commands |

## settings-ru

| `DATABASE_URL` | SHARED-PG | не задана | строка подключения к базе доски; ставится установщиком или вручную, на неё опирается форма `DUMP_COMMAND` / `RESTORE_COMMAND` для общего PostgreSQL | оставить команды по умолчанию через контейнер |
