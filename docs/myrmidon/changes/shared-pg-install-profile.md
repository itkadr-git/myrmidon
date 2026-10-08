---
divergence-section: Трек 5 — эксплуатация
settings-section: Track 5 — operations
---

## changelog-en

### SHARED-PG: a fresh install stands up one PostgreSQL 18 + pgvector shared database

- `scripts/myrmidon/install/install.sh` — the database layer of a clean
  install is now a PROFILE, not a hard-coded `postgres:17-alpine` container.
  The default (internal) profile runs ONE PostgreSQL 18 image with the
  pgvector extension (`docker.io/pgvector/pgvector:pg18`, overridable with
  `MYRMIDON_DB_IMAGE`, digest pinning included) and creates, on first start,
  a separate database and login role per service: the board (`paperclip`)
  plus the shared services `litellm`, `langfuse` and `hindsight`
  (`MYRMIDON_SHARED_SERVICES`); every service database gets the `vector`
  extension. The generator lives in `db-init/01-shared-roles.sh`, mounted
  into `/docker-entrypoint-initdb.d` — it is idempotent (a role/database that
  already exists is reused) and re-applies the memory parameters with
  `ALTER SYSTEM` so the sizing survives in the cluster.
- The server's memory parameters (`shared_buffers`,
  `effective_cache_size`, `maintenance_work_mem`, `work_mem`, `shm_size`)
  are sized for the SUM of all services sharing the cluster: by default from
  the host's `MemTotal` (capped at 16 GB) — shared_buffers = 1/4 RAM,
  effective_cache_size = 3/4 RAM, maintenance_work_mem = RAM/64 (>= 64 MB),
  work_mem = 16 MB, shm = RAM/8 clamped to 128 MB..1 GB. Every value is
  overridable in the install environment (`MYRMIDON_DB_TOTAL_MEMORY_MB`,
  `MYRMIDON_DB_SHARED_BUFFERS`, `MYRMIDON_DB_EFFECTIVE_CACHE_SIZE`,
  `MYRMIDON_DB_MAINTENANCE_WORK_MEM`, `MYRMIDON_DB_WORK_MEM`,
  `MYRMIDON_DB_SHM_SIZE`) and is written into `deploy.env`, so the numbers a
  cluster actually runs with are visible in one place.
- External shared server: `--database-url postgres://...` (or
  `MYRMIDON_INSTALL_DATABASE_URL` / the `DATABASE_URL` the operator exports)
  switches the installer to the external profile — no db service is written
  into `compose.yml`, no pgdata volume, the board's container points straight
  at the operator's server through `MYRMIDON_DATABASE_URL` in `deploy.env`.
  A non-`postgres://` URL is refused. The databases and roles on the external
  server are provisioned by the operator; the installer only validates the
  connection string shape.
- Existing installs are never migrated implicitly: a stack whose compose file
  carries a literal `image: postgres:` line and whose `deploy.env` names no
  profile gets the `keep` profile — re-running the installer (including
  `--version`) leaves its database container and data volume untouched.
  Moving a PG 17 database onto the shared PG 18 server is an operator task
  with its own procedure, not a side effect of an update.
- `docker/docker-compose.yml` and `docker/quadlet/paperclip-db.container`
  (the manual-deployment variants) move to the same
  `pgvector/pgvector:pg18` image; the compose variant gains the `db-init`
  bind mount and the sizing command line, mirroring what the installer
  generates.
- Tests: `scripts/myrmidon/install/install.test.mjs` gains the profile
  cases — a fresh install renders compose with the PG 18 + pgvector image,
  the sizing command line and the `db-init/01-shared-roles.sh` generator
  that creates the four databases and roles; `--database-url` produces no db
  service and no init directory; a malformed external URL is refused; an
  existing pre-profile stack is marked `keep` and its compose file is not
  rewritten.

## changelog-ru

### SHARED-PG: чистая установка поднимает один общий PostgreSQL 18 + pgvector

- `scripts/myrmidon/install/install.sh` — слой базы при чистой установке
  теперь ПРОФИЛЬ, а не вшитый контейнер `postgres:17-alpine`. Профиль по
  умолчанию (internal) поднимает ОДИН сервер PostgreSQL 18 с расширением
  pgvector (`docker.io/pgvector/pgvector:pg18`, переопределяется через
  `MYRMIDON_DB_IMAGE`, включая пин по digest) и при первом старте создаёт
  отдельную БД и роль логина для каждого сервиса: доска (`paperclip`) плюс
  общие сервисы `litellm`, `langfuse` и `hindsight`
  (`MYRMIDON_SHARED_SERVICES`); в каждой сервисной БД включается расширение
  `vector`. Генератор лежит в `db-init/01-shared-roles.sh` и монтируется в
  `/docker-entrypoint-initdb.d`; он идемпотентен (существующие роль/БД
  переиспользуются) и закрепляет параметры памяти через `ALTER SYSTEM`.
- Параметры памяти сервера (`shared_buffers`, `effective_cache_size`,
  `maintenance_work_mem`, `work_mem`, `shm_size`) считаются под СУММУ всех
  сервисов общего кластера: по умолчанию от `MemTotal` машины (потолок
  16 GB) — shared_buffers = 1/4 RAM, effective_cache_size = 3/4 RAM,
  maintenance_work_mem = RAM/64 (не менее 64 MB), work_mem = 16 MB,
  shm = RAM/8 в границах 128 MB..1 GB. Каждое значение переопределяется
  окружением установки (`MYRMIDON_DB_TOTAL_MEMORY_MB`,
  `MYRMIDON_DB_SHARED_BUFFERS`, `MYRMIDON_DB_EFFECTIVE_CACHE_SIZE`,
  `MYRMIDON_DB_MAINTENANCE_WORK_MEM`, `MYRMIDON_DB_WORK_MEM`,
  `MYRMIDON_DB_SHM_SIZE`) и записывается в `deploy.env`.
- Внешний общий сервер: `--database-url postgres://...` (или
  `MYRMIDON_INSTALL_DATABASE_URL` / экспортированный оператором
  `DATABASE_URL`) переключает установщик во внешний профиль — сервис db в
  `compose.yml` не пишется, volume pgdata нет, контейнер доски ходит прямо
  на сервер оператора через `MYRMIDON_DATABASE_URL` в `deploy.env`.
  Не-`postgres://` URL отклоняется. БД и роли на внешнем сервере создаёт
  оператор; установщик проверяет только форму строки подключения.
- Существующие установки не мигрируются молча: стек, у которого в compose
  стоит строчка `image: postgres:` и в `deploy.env` не назван профиль,
  получает профиль `keep` — повторный запуск установщика (включая
  `--version`) не трогает его контейнер базы и data volume. Перенос базы
  PG 17 на общий сервер PG 18 — задача оператора с отдельной процедурой, а
  не побочный эффект обновления.
- `docker/docker-compose.yml` и `docker/quadlet/paperclip-db.container`
  (варианты ручной раскатки) переводятся на тот же образ
  `pgvector/pgvector:pg18`; compose-вариант получает монтирование `db-init`
  и строку sizing, как в генерируемом установщике файле.
- Тесты: в `scripts/myrmidon/install/install.test.mjs` добавлены кейсы
  профиля — чистая установка рендерит compose с образом PG 18 + pgvector,
  строкой sizing и генератором `db-init/01-shared-roles.sh`, создающим четыре
  БД и роли; `--database-url` не создаёт сервис db и каталог init;
  некорректный внешний URL отклоняется; предпрофильная установка помечается
  `keep`, её compose не переписывается.

## divergence

| Трек 5 — эксплуатация | Чистая установка поднимает общий PostgreSQL 18 + pgvector: одна нода, отдельные БД и роли доски, LiteLLM, Langfuse и Hindsight, память — из env; внешний общий сервер подключается через `--database-url` без локального контейнера db; предпрофильные установки не трогаются |

## settings-en

| `MYRMIDON_DB_IMAGE` | SHARED-PG | `docker.io/pgvector/pgvector:pg18` | image of the shared PostgreSQL 18 + pgvector server of the internal profile (a `repo@sha256:...` digest pin is honoured) | set it to another image; `MYRMIDON_DB_PROFILE=external` drops the local server entirely |
| `MYRMIDON_DB_TOTAL_MEMORY_MB` | SHARED-PG | host `MemTotal`, capped at 16384 | the RAM budget the sizing below is computed from — sized for ALL services sharing the cluster | export it before running the installer |
| `MYRMIDON_DB_SHARED_BUFFERS` | SHARED-PG | total/4 MB | `shared_buffers` of the shared server | set an explicit value (e.g. `2GB`) |
| `MYRMIDON_DB_EFFECTIVE_CACHE_SIZE` | SHARED-PG | total*3/4 MB | `effective_cache_size` of the shared server | set an explicit value |
| `MYRMIDON_DB_MAINTENANCE_WORK_MEM` | SHARED-PG | total/64 MB (>= 64 MB) | `maintenance_work_mem` (index builds, the pgvector indexes included) | set an explicit value |
| `MYRMIDON_DB_WORK_MEM` | SHARED-PG | `16MB` | per-sort-node `work_mem` shared by every backend of the four services | set an explicit value |
| `MYRMIDON_DB_SHM_SIZE` | SHARED-PG | total/8, clamped 128 MB..1 GB | the container's `/dev/shm` for the parallel workers | set an explicit value or `MYRMIDON_DB_PROFILE=external` |
| `MYRMIDON_SHARED_SERVICES` | SHARED-PG | `litellm langfuse hindsight` | the extra databases/roles the shared cluster provisions next to the board's own; each service needs `MYRMIDON_<NAME>_PASSWORD` in the install environment | shrink or extend the list; the init script provisions exactly it |
| `MYRMIDON_INSTALL_DATABASE_URL` / `--database-url` | SHARED-PG | unset | external profile: point the board at the operator's shared PostgreSQL server; no db container, no pgdata volume is created | unset it and the installer falls back to the internal profile |
