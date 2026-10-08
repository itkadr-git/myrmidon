---
settings-section: Track 5 — operations
---

## changelog-en

### DB-TUNING: the PostgreSQL settings of the database audit are applied declaratively by the deploy (deploy.sh / rollback.sh)

- `scripts/myrmidon/deploy/db-tuning.sql` and
  `scripts/myrmidon/deploy/db-tuning-rollback.sql` — the declarative source of
  the settings from the OPE-4270 audit lives in the repository: `jit=off`,
  `work_mem=16MB`, `wal_compression=lz4`, `autovacuum_vacuum_scale_factor=0.05`
  (with `0.02` for `heartbeat_runs`, `agent_wakeup_requests`,
  `company_secrets`), `autovacuum_analyze_scale_factor=0.02` for `issues`, plus
  `pg_reload_conf()`. The rollback file resets exactly those. No manual
  `ALTER SYSTEM` on the live server anymore.
- `scripts/myrmidon/deploy/lib.sh` — four new optional deploy settings
  (`load_config`): `DB_TUNE_COMMAND` applies the tuning file (empty — the step
  is skipped), `DB_TUNE_SHOW_COMMAND` prints a `SHOW` value for the parameter
  name in `DB_TUNE_PARAM`, `DB_TUNE_EXPECTED` lists the `name=value` pairs to
  verify, `DB_TUNE_ROLLBACK_COMMAND` returns the previous settings (empty — the
  settings rollback is skipped with a warning). Before the first apply the
  live values are recorded to `$STATE_DIR/db-tuning-previous`.
- `scripts/myrmidon/deploy/deploy.sh` — a new step after the health check:
  apply, then verify every expected pair through SHOW; a mismatch is
  DEPLOY FAILED — maintenance stays on, the rollback command is printed, and
  the half-applied settings are returned via `DB_TUNE_ROLLBACK_COMMAND`
  (same failure shape as the health step). The dry-run plan describes the step
  like the others.
- `scripts/myrmidon/deploy/rollback.sh` — after the image and health steps:
  apply `DB_TUNE_ROLLBACK_COMMAND` and verify the same parameters SHOW against
  the recorded previous values; a mismatch fails the rollback loudly with
  maintenance staying on.
- `scripts/myrmidon/deploy/deploy.env.example` — the four settings documented
  with production examples.
- `docs/myrmidon/deploy.md` / `docs/myrmidon/deploy.ru.md` — a "DB-TUNING"
  section: the audit values, where the declarative source lives, how the
  deploy applies and verifies (SHOW), how the rollback returns, and the exact
  `pg_stat_statements` query for the before/after top-query timing.
- Tests: `scripts/myrmidon/deploy/deploy.test.mjs` — the step is skipped when
  `DB_TUNE_COMMAND` is empty; a matching SHOW passes; a SHOW mismatch fails the
  deploy, keeps maintenance on and rolls the settings back; `rollback.sh`
  applies `DB_TUNE_ROLLBACK_COMMAND` and restores the previous values.

## changelog-ru

### DB-TUNING: настройки PostgreSQL из аудита базы применяются декларативно конфигурацией выката (deploy.sh / rollback.sh)

- `scripts/myrmidon/deploy/db-tuning.sql` и
  `scripts/myrmidon/deploy/db-tuning-rollback.sql` — декларативный источник
  настроек из аудита OPE-4270 лежит в репозитории: `jit=off`, `work_mem=16MB`,
  `wal_compression=lz4`, `autovacuum_vacuum_scale_factor=0.05` (и `0.02` для
  `heartbeat_runs`, `agent_wakeup_requests`, `company_secrets`),
  `autovacuum_analyze_scale_factor=0.02` для `issues`, плюс `pg_reload_conf()`.
  Роллбэк-файл сбрасывает ровно их. Ручных `ALTER SYSTEM` на живой сервере
  больше нет.
- `scripts/myrmidon/deploy/lib.sh` — четыре новые необязательные настройки
  выката (`load_config`): `DB_TUNE_COMMAND` применяет файл настроек (пусто —
  шаг пропускается), `DB_TUNE_SHOW_COMMAND` печатает значение `SHOW` для
  параметра из `DB_TUNE_PARAM`, `DB_TUNE_EXPECTED` перечисляет пары
  `имя=значение` для проверки, `DB_TUNE_ROLLBACK_COMMAND` возвращает прежние
  настройки (пусто — откат настроек пропускается с предупреждением). Перед
  первым применением живые значения пишутся в `$STATE_DIR/db-tuning-previous`.
- `scripts/myrmidon/deploy/deploy.sh` — новый шаг после проверки health:
  применить, затем проверить каждую ожидаемую пару через SHOW; расхождение —
  DEPLOY FAILED: обслуживание остаётся, печатается команда отката,
  наполовину применённые настройки возвращаются через
  `DB_TUNE_ROLLBACK_COMMAND` (та же форма отказа, что у шага health). Dry-run
  описывает шаг как остальные.
- `scripts/myrmidon/deploy/rollback.sh` — после возврата образа и health:
  применить `DB_TUNE_ROLLBACK_COMMAND` и проверить те же параметры через SHOW
  по записанным прежним значениям; расхождение громко валит откат с
  остающимся обслуживанием.
- `scripts/myrmidon/deploy/deploy.env.example` — четыре настройки
  задокументированы с боевыми примерами.
- `docs/myrmidon/deploy.md` / `docs/myrmidon/deploy.ru.md` — подраздел
  «DB-TUNING»: значения из аудита, где лежит декларативный источник, как
  выкат применяет и проверяет (SHOW), как откат возвращает прежние значения,
  и точный запрос `pg_stat_statements` для замеров топ-запросов до/после.
- Тесты: `scripts/myrmidon/deploy/deploy.test.mjs` — шаг пропускается при
  пустом `DB_TUNE_COMMAND`; совпадающий SHOW проходит; расхождение SHOW валит
  выкат, оставляет обслуживание и откатывает настройки; `rollback.sh`
  применяет `DB_TUNE_ROLLBACK_COMMAND` и возвращает прежние значения.
## settings-en

| `DB_TUNE_COMMAND` | DB-TUNING | unset (step skipped) | Deploy-script setting (`deploy.env`): the shell command applying the declarative PostgreSQL settings of the audit (runs `scripts/myrmidon/deploy/db-tuning.sql`); after the apply deploy verifies every `DB_TUNE_EXPECTED` pair through `DB_TUNE_SHOW_COMMAND` | Empty — the whole DB-TUNING step is skipped with a log line. Read by `scripts/myrmidon/deploy/{lib,deploy,rollback}.sh`, not by the server |
| `DB_TUNE_SHOW_COMMAND` | DB-TUNING | unset (check skipped) | Deploy-script setting: the command that must print the `SHOW` value of the parameter named in the exported `DB_TUNE_PARAM` (e.g. `docker compose … exec -T db psql -tAc "SHOW $DB_TUNE_PARAM"`) | Empty — the SHOW verification is skipped with a log line (the apply still runs when `DB_TUNE_COMMAND` is set) |
| `DB_TUNE_EXPECTED` | DB-TUNING | unset (check skipped) | Deploy-script setting: `name=value` pairs, one per line, the values the audit expects (`jit=off`, `work_mem=16MB`, `wal_compression=lz4`, `autovacuum_vacuum_scale_factor=0.05`); `rollback.sh` verifies the same parameters against the values recorded in `$STATE_DIR/db-tuning-previous` before the first apply | Empty — no pairs, no verification |
| `DB_TUNE_ROLLBACK_COMMAND` | DB-TUNING | unset (rollback skipped) | Deploy-script setting: the command returning the previous settings (runs `scripts/myrmidon/deploy/db-tuning-rollback.sql`); called by `rollback.sh` and by deploy when the DB-TUNING step fails after the apply | Empty — the settings rollback is skipped with a WARNING: the database keeps the tuned values |

## settings-ru

| `DB_TUNE_COMMAND` | DB-TUNING | не задана (шаг пропускается) | Настройка скрипта выката (`deploy.env`): shell-команда, применяющая декларативные настройки PostgreSQL из аудита (выполняет `scripts/myrmidon/deploy/db-tuning.sql`); после применения выкат проверяет каждую пару `DB_TUNE_EXPECTED` через `DB_TUNE_SHOW_COMMAND` | Пусто — весь шаг DB-TUNING пропускается с журнальной строкой. Читается `scripts/myrmidon/deploy/{lib,deploy,rollback}.sh`, не сервером |
| `DB_TUNE_SHOW_COMMAND` | DB-TUNING | не задана (проверка пропускается) | Настройка выката: команда, печатающая значение `SHOW` параметра из экспортируемой `DB_TUNE_PARAM` (например `docker compose … exec -T db psql -tAc "SHOW $DB_TUNE_PARAM"`) | Пусто — проверка SHOW пропускается с журнальной строкой (применение всё равно выполняется при заданном `DB_TUNE_COMMAND`) |
| `DB_TUNE_EXPECTED` | DB-TUNING | не задана (проверка пропускается) | Настройка выката: пары `имя=значение` по строке — значения, ожидаемые аудитом (`jit=off`, `work_mem=16MB`, `wal_compression=lz4`, `autovacuum_vacuum_scale_factor=0.05`); `rollback.sh` проверяет те же параметры по значениям, записанным в `$STATE_DIR/db-tuning-previous` до первого применения | Пусто — нет пар, нет проверки |
| `DB_TUNE_ROLLBACK_COMMAND` | DB-TUNING | не задана (откат пропускается) | Настройка выката: команда возврата прежних настроек (выполняет `scripts/myrmidon/deploy/db-tuning-rollback.sql`); вызывается `rollback.sh` и выкатом при падении шага DB-TUNING после применения | Пусто — откат настроек пропускается с ПРЕДУПРЕЖДЕНИЕМ: база остаётся с настроенными значениями |

