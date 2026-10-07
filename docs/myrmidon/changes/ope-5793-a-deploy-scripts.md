---
divergence-section: Трек 5 — эксплуатация
settings-section: Track 5 — operations
---

## changelog-en

### Deploy scripts and the predeploy check no longer assume the built-in database container: shared PostgreSQL 18 (1.6.5 PREDEPLOY-PG-COMPAT)

- The board's database may live on a SHARED PostgreSQL 18 server (its own
  database and role; the same server hosts other products). The dump and
  restore commands were always pure configuration (`DUMP_COMMAND`,
  `RESTORE_COMMAND`), and `deploy.env.example` now carries both profiles: the
  built-in `db` container (unchanged default) and the shared server —
  `pg_dump "$DATABASE_URL"` / `pg_restore -d "$DATABASE_URL" --no-owner
  --no-acl`, run with a pg_dump 18 client from the deploy directory. On a
  shared server `--no-owner --no-acl` is required and the connection string
  must be only the board database and the board role. No container name is
  compiled into the scripts.
- The predeploy board check gained `PREDEPLOY-PG-COMPAT`: after the throwaway
  copy starts, the dump's own TOC (`pg_restore --list`) and the copy are
  compared — the server major the dump came from must equal the copy's major,
  and every extension the dump restores must be available in the copy image;
  after the restore, `SELECT extname FROM pg_extension` must show them
  installed. A mismatch (for example a copy image without `vector`, which the
  board has needed since migration 0051) stops the deploy before the
  maintenance window with a clear message. `MYRMIDON_PREDEPLOY_PG_COMPAT=off`
  skips the comparison; the ANALYZE step (PREDEPLOY-ANALYZE) is unchanged.
- `deploy.env.example` sets the copy image default to
  `pgvector/pgvector:pg18` for a new shared-server profile: PostgreSQL 18 with
  pgvector compiled in (the stock `postgres:18` image has no `vector`).

## changelog-ru

### Скрипты выката и предвыкатная проверка больше не предполагают встроенный контейнер базы: общий PostgreSQL 18 (1.6.5 PREDEPLOY-PG-COMPAT)

- База доски может жить на ОБЩЕМ сервере PostgreSQL 18 (отдельные БД и роль
  доски; тот же сервер обслуживает другие продукты). Команды дампа и
  восстановления всегда были чистой конфигурацией (`DUMP_COMMAND`,
  `RESTORE_COMMAND`), и `deploy.env.example` теперь содержит оба профиля:
  встроенный контейнер `db` (прежний default) и общий сервер —
  `pg_dump "$DATABASE_URL"` / `pg_restore -d "$DATABASE_URL" --no-owner
  --no-acl` с клиентом pg_dump 18 из каталога деплоя. На общем сервере
  `--no-owner --no-acl` обязательны, а строка соединения — только БД доски и
  её роль. Имена контейнеров в код не вшиты.
- Предвыкатная проверка доски получила `PREDEPLOY-PG-COMPAT`: после старта
  временной копии сравниваются TOC дампа (`pg_restore --list`) и копия —
  major-версия сервера, из которого снят дамп, обязана совпасть с major
  копии, и каждое расширение из дампа должно присутствовать в образе копии;
  после восстановления `SELECT extname FROM pg_extension` обязано показать их
  установленными. Несовпадение (например, образ копии без `vector`, нужного
  доске с миграции 0051) останавливает выкат до окна обслуживания с
  понятной ошибкой. `MYRMIDON_PREDEPLOY_PG_COMPAT=off` отключает сравнение;
  шаг ANALYZE (PREDEPLOY-ANALYZE) сохранён без изменений.
- `deploy.env.example` задаёт дефолт образа копии `pgvector/pgvector:pg18`
  для нового профиля общего сервера: PostgreSQL 18 с собранным pgvector
  (в стоковом `postgres:18` расширения `vector` нет).

## divergence

| PREDEPLOY-PG-COMPAT | Предвыкатная копия сравнивается с боевым дампом: major сервера (заголовок дампа против `SHOW server_version` копии) и все расширения дампа (`pg_restore --list`, затем `pg_extension` после восстановления) обязаны совпасть с образом копии; дампы/восстановления — чистая конфигурация (`DUMP_COMMAND`/`RESTORE_COMMAND`), общий PostgreSQL 18 поддерживается без вшитых имён контейнеров | `scripts/myrmidon/deploy/predeploy-board-check.sh`, `scripts/myrmidon/deploy/lib.sh`, `scripts/myrmidon/deploy/deploy.env.example` | Решение владельца 07.10: база доски на общем PostgreSQL 18 (свои БД и роль); копия, не совпадающая с боевым сервером, ничего не доказывает | `scripts/myrmidon/deploy/predeploy-board-check.test.mjs` (копия без pgvector — отказ; PG_COMPAT=off — предупреждение; дефолтный путь зелёный), `scripts/myrmidon/deploy/deploy.test.mjs` (dry-run профиля общего сервера) | Никогда, наше поведение; при переносе вендора сохранить блок PG-COMPAT и разбор `MYRMIDON_PREDEPLOY_PG_COMPAT` | (этот PR) |

## settings-en

| `MYRMIDON_PREDEPLOY_PG_COMPAT` | PREDEPLOY-PG-COMPAT | `check` | Deploy-script setting (`deploy.env`): after the throwaway copy starts, the predeploy check compares the copy with the production dump — same server major (dump header vs the copy's `SHOW server_version`) and every extension the dump restores available in the copy image, installed after the restore (`pg_extension`). A mismatch stops the deploy before the window | `off` — skip the comparison; a hard incompatibility still fails the restore itself |

## settings-ru

| `MYRMIDON_PREDEPLOY_PG_COMPAT` | PREDEPLOY-PG-COMPAT | `check` | Настройка скриптов выката (`deploy.env`): после старта временной копии предвыкатная проверка сравнивает её с боевым дампом — одинаковая major-версия сервера (заголовок дампа против `SHOW server_version` копии) и все расширения, которые дамп восстанавливает, доступны в образе копии и установлены после восстановления (`pg_extension`). Несовпадение останавливает выкат до окна | `off` — пропустить сравнение; жёсткая несовместимость всё равно упадёт на восстановлении |
