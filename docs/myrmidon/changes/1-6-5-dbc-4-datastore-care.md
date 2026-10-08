---
divergence-section: Трек 2 — ядро побудок и прогонов
settings-section: Track 2 — wake and run core
---

## changelog-en

### Snapshots and audit reports of the board's own database (1.6.5 DBC-4)

- Storage optimisation becomes a board function: the module
  `server/src/myrmidon/datastore-care/` collects one snapshot an hour of the
  datastore it runs on — total size (`pg_database_size`), per-table and TOAST
  bytes, index bytes, the heaviest `pg_stat_statements` queries, the settings
  the audit criteria watch, the age of the last backup — and keeps both
  snapshots and audit reports for 90 days of its own.
- Two myrmidon-owned tables, `datastore_snapshots` and
  `datastore_audit_reports` (migration
  `packages/db/src/migrations/0310_datastore_care.sql`, additive only), plus
  the granularity the module reports on: per-table bytes, transitions and the
  growth between neighbouring snapshots.
- `GET /api/myrmidon/datastores` answers the targets with their live size and
  the newest snapshot; `POST /api/myrmidon/datastores/:key/snapshots` takes an
  out-of-band snapshot; `POST /api/myrmidon/datastores/:key/audit-reports`
  writes the report of the section-6 criteria as it stands at that moment and
  `GET .../audit-reports/:id/export` returns it as the `db-audit.md` markdown
  (the top-25 queries and every criterion with its measured value).
- The routes are instance-admin only (`assertInstanceAdmin`): the numbers are
  the instance's own — database size, catalog contents, server parameters — so
  a board member of a company has nothing to read there. A snapshot keeps the
  indexes as aggregates (total, unused and their bytes, the largest unused, the
  invalid count) and not as the full list of ~1040 rows: kept hourly over the
  90-day retention that list alone would add ~200 MB per target.
- The collector is parameterised by connection and by `dbId`
  (`pg_database.oid`) from its first day, so DBC-5 only adds targets to the
  same code; the board target is implicit. pgvector and full-text-search
  metrics appear only when the extension is installed. `engine` stays
  `"postgres" | "clickhouse-ro"`.
- The hourly job runs behind the kill switch `MYRMIDON_DATASTORE_CARE_ENABLED`
  (any of `0/false/off/no/disabled` turns it off); no rules and no automatic
  actions are attached to the numbers collected — the module only measures and
  reports.
- The release gate `scripts/myrmidon/release/db-audit-gate.sh` turns one audit
  report into a release decision. For 1.6.5 it runs in **warning** mode:
  findings are printed and the release is not blocked; the next release runs
  the same script with `--mode block`, and `--strict` also fails on warnings.
- The 1.6.5 audit itself ships with the release:
  `docs/myrmidon/releases/1.6.5-db-audit.md` (the path the release checklist
  names for every final tag) carries the sizes slice, the criteria with their
  measured values, every adopted change with its effect, and the "after"
  slice to be taken on the live database; `releases/1.6.5/db-audit.md` is the
  short entry point that points at it.

## changelog-ru

### Снимки и отчёты аудита собственной базы доски (1.6.5 DBC-4)

- Оптимизация хранилищ становится функцией доски: модуль
  `server/src/myrmidon/datastore-care/` раз в час снимает снимок хранилища, на
  котором работает сама, — общий размер (`pg_database_size`), байты по
  таблицам и TOAST, байты индексов, самые тяжёлые запросы из
  `pg_stat_statements`, параметры, за которыми следят критерии аудита, и
  давность последней резервной копии, — и хранит снимки и отчёты аудита свои
  сроком 90 дней.
- Две myrmidon-таблицы `datastore_snapshots` и `datastore_audit_reports`
  (миграция `packages/db/src/migrations/0310_datastore_care.sql`, только
  добавление) и гранулярность, которой модуль отчитывается: байты по
  таблицам, переходы и рост между соседними снимками.
- `GET /api/myrmidon/datastores` отдаёт цели с живым размером и последним
  снимком; `POST /api/myrmidon/datastores/:key/snapshots` берёт снимок вне
  расписания; `POST /api/myrmidon/datastores/:key/audit-reports` пишет отчёт по
  критериям раздела 6 на текущий момент, `GET .../audit-reports/:id/export`
  отдаёт его как markdown `db-audit.md` (топ-25 запросов и каждый критерий с
  измеренным значением).
- Маршруты — только для администратора инстанса (`assertInstanceAdmin`): числа
  принадлежат самому инстансу (размер базы, содержимое каталога, параметры
  сервера), читать их участнику компании незачем. Снимок хранит индексы
  агрегатами (всего, неиспользуемых и их байты, крупнейший неиспользуемый,
  число некорректных), а не полным списком ~1040 записей: в ежечасной
  серии за 90 дней один этот список добавил бы ~200 МБ на цель.
- Коллектор с первого дня параметризован подключением и `dbId`
  (`pg_database.oid`), поэтому DBC-5 только добавляет цели в тот же код; цель
  `board` — implicit. Метрики pgvector и полнотекстового поиска появляются
  только при установленном расширении. `engine` остаётся
  `"postgres" | "clickhouse-ro"`.
- Ежечасная задача идёт за рубильником `MYRMIDON_DATASTORE_CARE_ENABLED` (любое
  из `0/false/off/no/disabled` выключает); к собранным числам не привязано ни
  правил, ни автоматических действий — модуль только измеряет и отчитывается.
- Гейт релиза `scripts/myrmidon/release/db-audit-gate.sh` превращает один отчёт
  аудита в решение о релизе. Для 1.6.5 он идёт в режиме **предупреждения**:
  находки печатаются, релиз не блокируется; следующий релиз запускает тот же
  скрипт с `--mode block`, а `--strict` валит и на предупреждениях.
- Сам аудит 1.6.5 лежит в репозитории: `docs/myrmidon/releases/1.6.5-db-audit.md`
  (адрес, который чек-лист релиза называет для каждого финального тега) —
  срез размеров, критерии с измеренными значениями, все принятые изменения с
  их эффектом и срез «после», снимаемый на живой базе; `releases/1.6.5/db-audit.md` —
  короткая точка входа на него.

## divergence

| DBC-4 | Модуль `datastore-care` и две собственные таблицы доски (`datastore_snapshots`, `datastore_audit_reports`, срок 90 дней) + гейт релиза `db-audit-gate.sh` в режиме предупреждения для 1.6.5 | `server/src/myrmidon/datastore-care/` (domain, settings, store, collectors/postgres, audit-report, service, routes, startup, index), `packages/db/src/schema/datastore_care.ts` + миграция `0310_datastore_care.sql` и мета, `server/src/app.ts`, `server/src/index.ts`, `scripts/myrmidon/release/db-audit-gate.sh`, `docs/myrmidon/releases/1.6.5-db-audit.md` (канонический отчёт аудита), `releases/1.6.5/db-audit.md` (точка входа на него) | Решение владельца 08.10: оптимизация хранилищ — функция доски, аудит БД обязателен перед финальным релизом; числа аудита 04.10 (таблица `heartbeat_runs` 1,17 ГБ, четыре горячих предиката без индекса) | `server/src/myrmidon/datastore-care/*.myrmidon.test.ts` (settings — умолчания, collectors/postgres — разбор снимка на скриптовом порту, audit-report — критерии и markdown, service — сбор и retention, routes — HTTP и доступы), `scripts/myrmidon/release/db-audit-gate.test.mjs` (режимы warn/block, устаревание, ввод), `packages/db/src/datastore-care-migration.myrmidon.test.ts` (статика файла/журнала/снапшота + применение на embedded Postgres), `releases/1.6.5/db-audit.md` | Когда вендор отдаст свои снимки и отчёты аудита базы — снять модуль и его таблицы (миграция односторонняя, CONVENTIONS §8); гейт переводится в `--mode block` со следующего релиза | (этот PR) |

## settings-en

| `MYRMIDON_DATASTORE_CARE_ENABLED` | DBC-4 | `1` (on) | The board watches its own database: once an hour it writes a snapshot (database size, per-table and TOAST bytes, index bytes, the heaviest `pg_stat_statements` queries, the settings the audit criteria watch, the age of the last backup) into `datastore_snapshots`, and on demand an audit report into `datastore_audit_reports`; both live 90 days of their own. Auditing only — no rules, no automatic actions | `0`/`false`/`off`/`no`/`disabled` — off: the hourly job does not start and the `/api/myrmidon/datastores*` routes answer 503 `datastore_care_disabled` |
| `MYRMIDON_DATASTORE_CARE_INTERVAL_SEC` | DBC-4 | `3600` | How many seconds between hourly snapshots | Non-numeric, `0` or negative — the default; the value is clamped to 60…86400 |
| `MYRMIDON_DATASTORE_CARE_RETENTION_DAYS` | DBC-4 | `90` | Own retention of `datastore_snapshots` and `datastore_audit_reports`; older rows are deleted by the same hourly pass | Non-numeric or negative — the default; the value is clamped to 1…3650 |
| `MYRMIDON_DATASTORE_CARE_TOP_QUERIES` | DBC-4 | `25` | How many heaviest queries the snapshot and the markdown export carry | Non-numeric or negative — the default; the value is clamped to 1…100 |
| `MYRMIDON_DATASTORE_CARE_BACKUP_DIR` | DBC-4 | the instance backup dir | Which directory the age of the last dump is read from (the `backup-freshness` criterion: ≤ 24 h) | Unset — the instance backup directory from the shared home-paths helpers |
| `MYRMIDON_DATASTORE_CARE_OPTIONAL_METRICS` | DBC-4 | `1` (on) | Extra metrics that only exist with an extension: pgvector column indexing and the full-text-search dictionary; without the extension the block reports `null`/`available: false` instead of failing | `0`/`false`/`off`/`no`/`disabled` — the optional block is not collected at all |

## settings-ru

| `MYRMIDON_DATASTORE_CARE_ENABLED` | DBC-4 | `1` (включено) | Доска следит за собственной базой: раз в час в `datastore_snapshots` ложится снимок (размер базы, байты по таблицам и TOAST, байты индексов, самые тяжёлые запросы `pg_stat_statements`, параметры, за которыми следят критерии аудита, давность последней копии), по кнопке — отчёт аудита в `datastore_audit_reports`; у обоих свой срок 90 дней. Только аудит — ни правил, ни автоматических действий | `0`/`false`/`off`/`no`/`disabled` — выключено: ежечасная задача не запускается, маршруты `/api/myrmidon/datastores*` отвечают 503 `datastore_care_disabled` |
| `MYRMIDON_DATASTORE_CARE_INTERVAL_SEC` | DBC-4 | `3600` | Через сколько секунд брать следующий снимок | Не число, `0` или отрицательное — умолчание; значение зажимается в 60…86400 |
| `MYRMIDON_DATASTORE_CARE_RETENTION_DAYS` | DBC-4 | `90` | Свой срок хранения `datastore_snapshots` и `datastore_audit_reports`; старые строки удаляет тот же ежечасный проход | Не число или отрицательное — умолчание; значение зажимается в 1…3650 |
| `MYRMIDON_DATASTORE_CARE_TOP_QUERIES` | DBC-4 | `25` | Сколько самых тяжёлых запросов попадает в снимок и в markdown-экспорт | Не число или отрицательное — умолчание; значение зажимается в 1…100 |
| `MYRMIDON_DATASTORE_CARE_BACKUP_DIR` | DBC-4 | каталог резервных копий экземпляра | Из какого каталога читается давность последнего дампа (критерий `backup-freshness`: ≤ 24 ч) | Не задано — каталог резервных копий экземпляра из общих home-paths | 
| `MYRMIDON_DATASTORE_CARE_OPTIONAL_METRICS` | DBC-4 | `1` (включено) | Дополнительные метрики, которые есть только с расширением: индексация колонок pgvector и справочник полнотекстового поиска; без расширения блок отдаёт `null`/`available: false`, а не падает | `0`/`false`/`off`/`no`/`disabled` — дополнительный блок не собирается вовсе |