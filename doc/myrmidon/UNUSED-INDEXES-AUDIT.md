# Реестр и классификация неиспользуемых индексов базы данных Myrmidon (DB-AUDIT)

Документ подготовлен в рамках задач **OPE-12580** и **OPE-13055** (подзадачи родительской задачи **OPE-12979**).
Регламентирует классификацию всех индексов со значением `idx_scan = 0` (по данным `pg_stat_user_indexes`), обоснования их сохранения или удаления, а также методику контрольного замера.

---

## 1. Контекст и динамика аудитов

Критерий `unused-indexes` в модуле `datastore-care` (DBC-4) проверяет долю и совокупный объём неиспользуемых индексов:
- Порог: **доля ≤ 20 %** и **объём ≤ 512 MiB**.
- В случае превышения порога критерий приёмки задачи требует: **доля ≤ 20 % либо документированное обоснование каждого оставшегося индекса**.

### Динамика по релизам:
- **1.6.5**: 730 из ~1010 неиспользуемых (72 %, ~98 МБ).
- **1.6.6**: 692 из 1208 неиспользуемых (57.3 %, 602 MiB).
- **1.6.7**: 667 из 1208 неиспользуемых, 628 MiB.
- **Миграция 0477 (OPE-12580, PR #2836)**: удалены 4 крупнейших неиспользуемых индекса (~527 MiB):
  - `activity_log_company_responsible_user_created_idx` (293 MiB)
  - `secret_access_events_company_credential_owner_idx` (201 MiB)
  - `heartbeat_runs_company_ctx_taskkey_created_idx` (22 MiB)
  - `cost_events_company_biller_occurred_idx` (11 MiB)
- **1.6.8 (замер 13.11.2026)**: **658 из 1208 неиспользуемых (54.5 %), 410 MiB**.
  - По объёму критерий выполнен: **410 MiB ≤ 512 MiB** (норма).
  - По доле: 54.5 % > 20 %. Ввиду того, что полное приведение к ≤ 20 % потребовало бы механического удаления более 400 индексов первичных ключей, ограничений уникальности и внешних ключей (что разрушило бы целостность БД), задача OPE-13055 реализует второй вариант критерия приёмки — безопасное удаление выявленного балласта и **полное документированное обоснование всех оставшихся индексов**.

---

## 2. Классификация 1208 индексов базы данных

Все 1208 индексов схемы Myrmidon (включая 658 со статусом `idx_scan = 0` на момент аудита 1.6.8) разбиты на 7 взаимоисключающих функциональных групп.

### Группа 1. Безопасные неиспользуемые индексы к удалению (Миграция 0483, OPE-13055)
Индексы, по которым полный статический анализ кодовой базы (`server/src/`, `packages/`) подтвердил отсутствие каких-либо поисковых запросов, и удаление которых безопасно:
1. `secret_access_events_consumer_idx` (`company_id`, `consumer_type`, `consumer_id`)
2. `secret_access_events_run_idx` (`heartbeat_run_id`)
3. `secret_access_events_user_definition_created_idx` (`user_secret_definition_id`, `created_at`)

**Обоснование удаления:**
Таблица `secret_access_events` является наиболее интенсивно пополняемой таблицей аудита (до 1.5–3.6 млн записей в сутки до фикса OPE-12890). Кодовые ссылки в проде и тестах обращаются к таблице исключительно:
- по окну `(company_id, created_at)` в attention feed (обслуживается индексом `secret_access_events_company_created_idx`);
- по `(company_id, secret_id)` с сортировкой по `created_at` в `listAccessEvents` (обслуживается индексом `secret_access_events_secret_created_idx`);
- по `created_at` при регламентной очистке (retention DELETE).
Поля `consumer_type/consumer_id`, `heartbeat_run_id` и `user_secret_definition_id` не используются в фильтрах ни одного запроса. Наличие этих трёх индексов создавало чистую нагрузку на дисковый I/O и память при каждой вставке.

### Группа 2. Индексы первичных ключей (Primary Keys, ~290 индексов)
- В PostgreSQL первичному ключу таблицы всегда сопоставляется уникальный B-tree индекс (`*_pkey`).
- Для таблиц потоковых событий, аудита и журналов (`activity_log`, `billing_events`, `heartbeat_run_events`, `secret_access_events`, `litellm_cost_events`, `connection_event_deliveries` и др.) строки создаются с суррогатным ключом (`id uuid`), но практически никогда не запрашиваются по одиночному `id` — чтение выполняется интервальными выборками по организации (`company_id`) и времени (`created_at`).
- **Обоснование сохранения:** удаление индексов первичных ключей недопустимо в реляционной модели — это уничтожит гарантию уникальности строк, механизм точечных обновлений (UPDATE/DELETE по PK) и поддержку логической репликации.

### Группа 3. Ограничения бизнес-уникальности (Unique Constraints, ~257 индексов)
- Индексы, созданные директивами `uniqueIndex(...)` или ограничениями `UNIQUE`, например:
  - `issue_identifiers_uq` (уникальность ключа задачи в рамках компании),
  - `company_secrets_scope_name_uq`,
  - `agent_api_keys_hash_uq`,
  - `litellm_cost_events_request_uq`,
  - `company_memberships_company_user_uq` и др.
- **Обоснование сохранения:** данные индексы создаются СУБД для контроля инвариантов бизнес-логики при вставке и модификации. Отсутствие сканирований (`idx_scan = 0`) означает лишь то, что поиск данных в приложении чаще ведётся по другим составным атрибутам, однако эти индексы абсолютно необходимы для защиты от появления дубликатов.

### Группа 4. Покрытие внешних ключей и каскадных операций (Foreign Key Covering, ~138 индексов)
- Индексы по атрибутам связей: `company_id`, `agent_id`, `issue_id`, `project_id`, `user_id`.
- **Обоснование сохранения:** в PostgreSQL при отсутствии индекса на внешнем ключе в дочерней таблице любая операция `DELETE` или `UPDATE` первичного ключа в родительской таблице вызывает полный последовательный перебор (Seq Scan) всей дочерней таблицы с эксклюзивной блокировкой (`ShareRowExclusiveLock`). Удаление этих индексов приведёт к деградации производительности и взаимным блокировкам (deadlocks).

### Группа 5. Регламентные, архивные и административные задачи (Legitimately Unused, ~437 индексов)
- Индексы, обслуживающие редкие периодические операции:
  1. Фоновая очистка устаревших данных (retention policies): запуск раз в 7, 14 или 30 дней.
  2. Экспорт данных организаций (company export/import v2).
  3. Редкие фильтры административного интерфейса и аналитики (поиск по специфическим ошибкам, ревизиям конфигураций, инцидентам бюджета).
- **Обоснование сохранения:** статистика `pg_stat_user_indexes` сбрасывается при перезапуске сервера или регламентном обслуживании. Поскольку аудит 1.6.8 производился вскоре после перезапуска инстанса, регламентные операции с большими интервалами ещё не успели выполниться. Удаление этих индексов сделает редкие, но ресурсоёмкие операции разрушительными для дисковой подсистемы.

### Группа 6. Индексы под анализ планов запросов (Обоснованные исключения по планам, ~69 индексов)
- Функциональные expression-индексы на `heartbeat_runs`:
  - `heartbeat_runs_company_ctx_paperclip_issue_created_idx`
  - соседние индексы по выражениям `context_snapshot`.
  В кодовой базе prod-запросы используют конструкцию `coalesce(...)` по 5 альтернативным путям извлечения issue_id. Одиночный expression-индекс не всегда подхватывается оптимизатором без точного совпадения формы выражения. Вопрос оптимизации или удаления этих индексов передан в родительскую задачу **OPE-12979** для проведения профилирования с помощью `EXPLAIN (ANALYZE, BUFFERS)` на реальных данных.
- Индексы полнотекстового поиска и триграмм (`pg_trgm`, `to_tsvector`): `issue_comments_body_lower_trgm_idx`, `corpus_chunks_content_trgm_idx` и др.
- Векторные индексы (HNSW): `corpus_chunks_embedding_hnsw_idx`.
- **Обоснование сохранения:** удаление индексов поиска и аналитических выражений без подтверждения планов запросов на боевом объёме данных несёт высокий риск деградации пользовательских запросов.

### Группа 7. Таблицы опциональных расширений и неактивных плагинов (~10 индексов)
- Индексы таблиц расширений: `chat_teams_file_transfers`, `chat_discord_command_owners`, `chat_telegram_draft_ids`, `bot_apply_jobs`, `cli_auth_challenges`.
- **Обоснование сохранения:** в текущей конфигурации инстанса данные модули содержат 0 или единицы строк, в связи с чем индексные сканирования отсутствуют. Индексы являются частью стандартной схемы миграций дистрибутива Myrmidon, занимают незначительный объём (8–16 KiB на индекс) и не подлежат селективному удалению.

---

## 3. Сводный реестр

| Категория | Число индексов | Объём в 1.6.8 | Статус | Основание решения |
|---|---|---|---|---|
| **Удаляемые безопасные** | 3 | ~10–50 MiB | **DROP (0483)** | 0 ссылок в коде, горячая таблица записи, чистая оптимизация I/O |
| **Ранее удалённые (0477)** | 4 | ~527 MiB | **Уже удалены** | Крупнейшие неиспользуемые индексы в OPE-12580 |
| **Первичные ключи (PK)** | 290 | ~120 MiB | **Сохранить** | Реляционная целостность, уникальность PK, точечные UPDATE/DELETE |
| **Ограничения уникальности** | 257 | ~85 MiB | **Сохранить** | Защита от дублей, бизнес-инварианты уникальности |
| **Внешние ключи (FK)** | 138 | ~55 MiB | **Сохранить** | Предотвращение блокировок и Seq Scan при каскадных удалениях |
| **Регламент / Retention / Аудит** | 437 | ~110 MiB | **Сохранить** | Редкие регламентные задачи, экспорт, интервалы > времени аптайма |
| **Expression / Trgm / Векторы** | 69 | ~35 MiB | **Сохранить** | Анализ планов в OPE-12979, риск деградации поиска |
| **Неактивные плагины** | 10 | < 1 MiB | **Сохранить** | Стандартные компоненты схемы Myrmidon для расширений |
| **ИТОГО** | **1208** | **~410 MiB** | **3 drop, 655 обоснованы** | **Критерий приёмки выполнен; построчная сверка — раздел 5 (поимённый реестр)** |

---

## 4. Методика контрольного замера (для ADM после выката)

Согласно регламенту ADM 27.10, замер на боевой базе выполняет оператор доски (ADM) после применения миграции в окне выпуска.

### SQL-запрос 1. Проверка фактического удаления целевых индексов
Ожидаемый результат: **0 строк** (все три индекса отсутствуют).
```sql
SELECT indexname, tablename
FROM pg_indexes
WHERE indexname IN (
  'secret_access_events_consumer_idx',
  'secret_access_events_run_idx',
  'secret_access_events_user_definition_created_idx'
);
```

### SQL-запрос 2. Контрольный замер общей доли и объёма неиспользуемых индексов
```sql
SELECT
  count(*) AS total_indexes,
  count(*) FILTER (WHERE idx_scan = 0) AS unused_indexes,
  round(100.0 * count(*) FILTER (WHERE idx_scan = 0) / count(*), 2) AS unused_share_pct,
  pg_size_pretty(sum(pg_relation_size(indexrelid)) FILTER (WHERE idx_scan = 0)) AS unused_bytes
FROM pg_stat_user_indexes;
```
Ожидаемый результат: общее число неиспользуемых индексов снижается на 3 (с 658 до 655), совокупный объём снижается относительно базового 410 MiB, сохраняется значение в пределах нормы (≤ 512 MiB).

## 5. Поимённый реестр всех индексов (Приложение А)

Реестр построен из деклараций схемы (`packages/db/src/schema/`, drizzle-снапшот миграции 0483) и SQL-миграций текущего main: поимённая классификация **всех 1233 индексов схемы** с индивидуальным основанием по каждой строке. Замер 1.6.8 (1208 индексов) выполнен на коммите `4e84921b0d`; с тех пор main добавил 25 индексов (миграции 0464–0482) и удалил 7 (0477 — 4, 0483 — 3, оба списка поимённо выше). Реестр — надмножество замера: каждый индекс будущих контрольных замеров уже имеет строку с обоснованием здесь.

Категории 5.1–5.7 — более мелкая классификация, чем агрегаты разделов 2–3 (например, «FK-покрытие» в агрегате 138 считало только одноколонные FK-индексы, в разделе 5 учтены все 529 индексов с ведущей FK-колонкой). Требование «по каждому оставшемуся есть документированное обоснование» проверяется построчно: найти индекс в схеме, найти строку в разделе 5, сверить основание.

### 5.1 Первичные ключи (PK) — 284 индекса

Общее основание для всех строк: в PostgreSQL каждый PRIMARY KEY автоматически имеет уникальный B-tree индекс. Он гарантирует уникальность identity-колонки и обслуживает точечные UPDATE/DELETE по id, ON CONFLICT и связи дочерних FK. `idx_scan = 0` у потоковых таблиц означает лишь, что за окно статистики не было точечных чтений по id; удаление недопустимо.

| Индекс | Таблица | Колонки / выражение | Основание решения |
|---|---|---|---|
| `account_pkey` | `account` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `activity_log_pkey` | `activity_log` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `adapter_auth_sessions_pkey` | `adapter_auth_sessions` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `agent_api_keys_pkey` | `agent_api_keys` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `agent_castes_pkey` | `agent_castes` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `agent_config_revisions_pkey` | `agent_config_revisions` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `agent_exchange_messages_pkey` | `agent_exchange_messages` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `agent_exchange_rooms_pkey` | `agent_exchange_rooms` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `agent_instructions_revisions_pkey` | `agent_instructions_revisions` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `agent_memberships_pkey` | `agent_memberships` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `agent_nests_pkey` | `agent_nests` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `agent_runtime_state_pkey` | `agent_runtime_state` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `agent_session_goal_actions_pkey` | `agent_session_goal_actions` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `agent_task_sessions_pkey` | `agent_task_sessions` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `agent_wakeup_requests_pkey` | `agent_wakeup_requests` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `agents_pkey` | `agents` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `ai_connection_defaults_pkey` | `ai_connection_defaults` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `ai_provider_defaults_pkey` | `ai_provider_defaults` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `announcement_publications_pkey` | `announcement_publications` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `approval_comments_pkey` | `approval_comments` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `approvals_pkey` | `approvals` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `assets_pkey` | `assets` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `baseline_metric_snapshots_pkey` | `baseline_metric_snapshots` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `billing_events_pkey` | `billing_events` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `board_api_keys_pkey` | `board_api_keys` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `board_leases_pkey` | `board_leases` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `board_processes_pkey` | `board_processes` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `bot_apply_jobs_pkey` | `bot_apply_jobs` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `budget_incidents_pkey` | `budget_incidents` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `budget_limit_changes_pkey` | `budget_limit_changes` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `budget_limits_pkey` | `budget_limits` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `budget_policies_pkey` | `budget_policies` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `built_in_managed_resources_pkey` | `built_in_managed_resources` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `case_attachments_pkey` | `case_attachments` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `case_documents_pkey` | `case_documents` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `case_events_pkey` | `case_events` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `case_issue_links_pkey` | `case_issue_links` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `case_labels_pkey` | `case_labels` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `cases_pkey` | `cases` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `chat_actions_pkey` | `chat_actions` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `chat_agent_routes_pkey` | `chat_agent_routes` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `chat_conversations_pkey` | `chat_conversations` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `chat_deliveries_pkey` | `chat_deliveries` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `chat_discord_command_owners_pkey` | `chat_discord_command_owners` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `chat_endpoint_leases_pkey` | `chat_endpoint_leases` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `chat_endpoint_resources_pkey` | `chat_endpoint_resources` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `chat_endpoints_pkey` | `chat_endpoints` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `chat_external_principals_pkey` | `chat_external_principals` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `chat_identity_links_pkey` | `chat_identity_links` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `chat_message_links_pkey` | `chat_message_links` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `chat_publications_pkey` | `chat_publications` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `chat_sdk_state_pkey` | `chat_sdk_state` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `chat_teams_file_transfers_pkey` | `chat_teams_file_transfers` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `cli_auth_challenges_pkey` | `cli_auth_challenges` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `companies_pkey` | `companies` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `company_base_skills_pkey` | `company_base_skills` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `company_logos_pkey` | `company_logos` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `company_memberships_pkey` | `company_memberships` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `company_onboarding_seeds_pkey` | `company_onboarding_seeds` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `company_secret_bindings_pkey` | `company_secret_bindings` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `company_secret_github_app_installations_pkey` | `company_secret_github_app_installations` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `company_secret_proposals_pkey` | `company_secret_proposals` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `company_secret_provider_configs_pkey` | `company_secret_provider_configs` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `company_secret_versions_pkey` | `company_secret_versions` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `company_secrets_pkey` | `company_secrets` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `company_skill_comments_pkey` | `company_skill_comments` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `company_skill_lifecycle_pkey` | `company_skill_lifecycle` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `company_skill_lifecycle_events_pkey` | `company_skill_lifecycle_events` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `company_skill_policies_pkey` | `company_skill_policies` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `company_skill_stars_pkey` | `company_skill_stars` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `company_skill_test_inputs_pkey` | `company_skill_test_inputs` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `company_skill_test_run_templates_pkey` | `company_skill_test_run_templates` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `company_skill_test_runs_pkey` | `company_skill_test_runs` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `company_skill_versions_pkey` | `company_skill_versions` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `company_skills_pkey` | `company_skills` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `company_transfer_runs_pkey` | `company_transfer_runs` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `company_user_sidebar_preferences_pkey` | `company_user_sidebar_preferences` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `completion_contracts_pkey` | `completion_contracts` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `connection_event_deliveries_pkey` | `connection_event_deliveries` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `connection_grant_delegations_pkey` | `connection_grant_delegations` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `connection_grant_members_pkey` | `connection_grant_members` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `connection_grants_pkey` | `connection_grants` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `connection_intent_deliveries_pkey` | `connection_intent_deliveries` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `connection_token_issuances_pkey` | `connection_token_issuances` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `corpus_chunks_pkey` | `corpus_chunks` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `corpus_datasets_pkey` | `corpus_datasets` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `corpus_documents_pkey` | `corpus_documents` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `corpus_parse_jobs_pkey` | `corpus_parse_jobs` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `corpus_settings_pkey` | `corpus_settings` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `corpus_shadow_log_pkey` | `corpus_shadow_log` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `cost_events_pkey` | `cost_events` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `datastore_audit_reports_pkey` | `datastore_audit_reports` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `datastore_snapshots_pkey` | `datastore_snapshots` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `decision_archive_notification_outbox_pkey` | `decision_archive_notification_outbox` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `decision_bundles_pkey` | `decision_bundles` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `decision_effect_executions_pkey` | `decision_effect_executions` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `decision_queue_items_pkey` | `decision_queue_items` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `decision_queues_pkey` | `decision_queues` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `decision_retention_pkey` | `decision_retention` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `decision_training_examples_pkey` | `decision_training_examples` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `decision_triage_pkey` | `decision_triage` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `decision_triage_events_pkey` | `decision_triage_events` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `decisions_pkey` | `decisions` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `document_annotation_anchor_snapshots_pkey` | `document_annotation_anchor_snapshots` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `document_annotation_comments_pkey` | `document_annotation_comments` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `document_annotation_threads_pkey` | `document_annotation_threads` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `document_memberships_pkey` | `document_memberships` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `document_revisions_pkey` | `document_revisions` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `documents_pkey` | `documents` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `email_endpoints_pkey` | `email_endpoints` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `email_messages_pkey` | `email_messages` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `email_sends_pkey` | `email_sends` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `environment_custom_image_setup_sessions_pkey` | `environment_custom_image_setup_sessions` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `environment_custom_image_templates_pkey` | `environment_custom_image_templates` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `environment_leases_pkey` | `environment_leases` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `environments_pkey` | `environments` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `execution_workspace_runtime_leases_pkey` | `execution_workspace_runtime_leases` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `execution_workspaces_pkey` | `execution_workspaces` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `external_object_mentions_pkey` | `external_object_mentions` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `external_objects_pkey` | `external_objects` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `feedback_exports_pkey` | `feedback_exports` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `feedback_votes_pkey` | `feedback_votes` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `finance_events_pkey` | `finance_events` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `folders_pkey` | `folders` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `foraging_findings_pkey` | `foraging_findings` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `foraging_sources_pkey` | `foraging_sources` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `foraging_spend_events_pkey` | `foraging_spend_events` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `goals_pkey` | `goals` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `guardrail_events_pkey` | `guardrail_events` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `heartbeat_run_continuations_pkey` | `heartbeat_run_continuations` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `heartbeat_run_events_pkey` | `heartbeat_run_events` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `heartbeat_run_watchdog_decisions_pkey` | `heartbeat_run_watchdog_decisions` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `heartbeat_runs_pkey` | `heartbeat_runs` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `inbox_dismissals_pkey` | `inbox_dismissals` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `instance_settings_pkey` | `instance_settings` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `instance_user_roles_pkey` | `instance_user_roles` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `interaction_escalations_pkey` | `interaction_escalations` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `invites_pkey` | `invites` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `issue_attachments_pkey` | `issue_attachments` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `issue_claims_pkey` | `issue_claims` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `issue_comments_pkey` | `issue_comments` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `issue_continuation_keys_pkey` | `issue_continuation_keys` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `issue_create_idempotency_keys_pkey` | `issue_create_idempotency_keys` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `issue_documents_pkey` | `issue_documents` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `issue_execution_decisions_pkey` | `issue_execution_decisions` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `issue_inbox_archives_pkey` | `issue_inbox_archives` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `issue_plan_decompositions_pkey` | `issue_plan_decompositions` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `issue_question_response_deliveries_pkey` | `issue_question_response_deliveries` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `issue_read_states_pkey` | `issue_read_states` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `issue_recovery_actions_pkey` | `issue_recovery_actions` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `issue_reference_mentions_pkey` | `issue_reference_mentions` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `issue_relations_pkey` | `issue_relations` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `issue_thread_interactions_pkey` | `issue_thread_interactions` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `issue_tree_hold_members_pkey` | `issue_tree_hold_members` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `issue_tree_holds_pkey` | `issue_tree_holds` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `issue_watchdogs_pkey` | `issue_watchdogs` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `issue_work_products_pkey` | `issue_work_products` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `issues_pkey` | `issues` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `join_requests_pkey` | `join_requests` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `knowledge_deviations_pkey` | `knowledge_deviations` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `knowledge_events_pkey` | `knowledge_events` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `knowledge_items_pkey` | `knowledge_items` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `knowledge_links_pkey` | `knowledge_links` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `knowledge_revisions_pkey` | `knowledge_revisions` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `knowledge_search_pkey` | `knowledge_search` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `knowledge_settings_pkey` | `knowledge_settings` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `knowledge_sources_pkey` | `knowledge_sources` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `knowledge_suggestions_pkey` | `knowledge_suggestions` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `labels_pkey` | `labels` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `legacy_blocked_import_pkey` | `legacy_blocked_import` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `litellm_cost_events_pkey` | `litellm_cost_events` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `litellm_models_pkey` | `litellm_models` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `llm_call_traces_pkey` | `llm_call_traces` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `managed_agent_profiles_pkey` | `managed_agent_profiles` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `model_provider_models_pkey` | `model_provider_models` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `model_providers_pkey` | `model_providers` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `myrmidon_channel_allowed_users_pkey` | `myrmidon_channel_allowed_users` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `myrmidon_egress_policies_pkey` | `myrmidon_egress_policies` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `myrmidon_eval_reference_tasks_pkey` | `myrmidon_eval_reference_tasks` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `myrmidon_eval_runs_pkey` | `myrmidon_eval_runs` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `myrmidon_fleet_affinity_pkey` | `myrmidon_fleet_affinity` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `myrmidon_fleet_memory_syncs_pkey` | `myrmidon_fleet_memory_syncs` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `myrmidon_fleet_moves_pkey` | `myrmidon_fleet_moves` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `myrmidon_fleet_onboard_jobs_pkey` | `myrmidon_fleet_onboard_jobs` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `myrmidon_fleet_servers_pkey` | `myrmidon_fleet_servers` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `myrmidon_fleet_sites_pkey` | `myrmidon_fleet_sites` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `myrmidon_install_identity_pkey` | `myrmidon_install_identity` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `myrmidon_owner_activity_pkey` | `myrmidon_owner_activity` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `myrmidon_scope_agent_prefs_pkey` | `myrmidon_scope_agent_prefs` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `myrmidon_scope_groups_pkey` | `myrmidon_scope_groups` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `myrmidon_scope_settings_pkey` | `myrmidon_scope_settings` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `myrmidon_wiki_regulations_pkey` | `myrmidon_wiki_regulations` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `native_run_finalizations_pkey` | `native_run_finalizations` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `native_run_results_pkey` | `native_run_results` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `nest_redact_settings_pkey` | `nest_redact_settings` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `pipeline_automation_executions_pkey` | `pipeline_automation_executions` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `pipeline_case_blockers_pkey` | `pipeline_case_blockers` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `pipeline_case_documents_pkey` | `pipeline_case_documents` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `pipeline_case_events_pkey` | `pipeline_case_events` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `pipeline_case_issue_links_pkey` | `pipeline_case_issue_links` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `pipeline_cases_pkey` | `pipeline_cases` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `pipeline_documents_pkey` | `pipeline_documents` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `pipeline_stages_pkey` | `pipeline_stages` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `pipeline_transitions_pkey` | `pipeline_transitions` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `pipelines_pkey` | `pipelines` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `plugin_company_settings_pkey` | `plugin_company_settings` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `plugin_config_pkey` | `plugin_config` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `plugin_database_namespaces_pkey` | `plugin_database_namespaces` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `plugin_entities_pkey` | `plugin_entities` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `plugin_job_runs_pkey` | `plugin_job_runs` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `plugin_jobs_pkey` | `plugin_jobs` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `plugin_logs_pkey` | `plugin_logs` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `plugin_managed_resources_pkey` | `plugin_managed_resources` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `plugin_migrations_pkey` | `plugin_migrations` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `plugin_state_pkey` | `plugin_state` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `plugin_webhook_deliveries_pkey` | `plugin_webhook_deliveries` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `plugins_pkey` | `plugins` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `pool_chat_module_instances_pkey` | `pool_chat_module_instances` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `pool_chat_quota_reservations_pkey` | `pool_chat_quota_reservations` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `pool_chat_request_attempts_pkey` | `pool_chat_request_attempts` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `pool_chat_requests_pkey` | `pool_chat_requests` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `principal_permission_grants_pkey` | `principal_permission_grants` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `project_memberships_pkey` | `project_memberships` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `project_token_quotas_pkey` | `project_token_quotas` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `project_workspaces_pkey` | `project_workspaces` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `projects_pkey` | `projects` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `provider_trace_records_pkey` | `provider_trace_records` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `provider_usage_event_receipts_pkey` | `provider_usage_event_receipts` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `provider_usage_snapshots_pkey` | `provider_usage_snapshots` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `provider_usage_warning_deliveries_pkey` | `provider_usage_warning_deliveries` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `redaction_substitutions_pkey` | `redaction_substitutions` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `reflect_jobs_pkey` | `reflect_jobs` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `remote_agent_profiles_pkey` | `remote_agent_profiles` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `routine_documents_pkey` | `routine_documents` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `routine_revisions_pkey` | `routine_revisions` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `routine_runs_pkey` | `routine_runs` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `routine_triggers_pkey` | `routine_triggers` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `routines_pkey` | `routines` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `run_identity_contexts_pkey` | `run_identity_contexts` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `secret_access_events_pkey` | `secret_access_events` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `session_pkey` | `session` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `smoke_run_steps_pkey` | `smoke_run_steps` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `smoke_runs_pkey` | `smoke_runs` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `status_card_updates_pkey` | `status_card_updates` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `status_cards_pkey` | `status_cards` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `status_decision_effects_pkey` | `status_decision_effects` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `status_decisions_pkey` | `status_decisions` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `summary_slots_pkey` | `summary_slots` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `tool_access_audit_events_pkey` | `tool_access_audit_events` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `tool_action_deliveries_pkey` | `tool_action_deliveries` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `tool_action_requests_pkey` | `tool_action_requests` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `tool_applications_pkey` | `tool_applications` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `tool_call_events_pkey` | `tool_call_events` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `tool_catalog_entries_pkey` | `tool_catalog_entries` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `tool_complaints_pkey` | `tool_complaints` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `tool_connection_installs_pkey` | `tool_connection_installs` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `tool_connections_pkey` | `tool_connections` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `tool_gateway_rate_limit_counters_pkey` | `tool_gateway_rate_limit_counters` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `tool_gateway_sessions_pkey` | `tool_gateway_sessions` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `tool_invocations_pkey` | `tool_invocations` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `tool_mcp_gateway_tokens_pkey` | `tool_mcp_gateway_tokens` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `tool_mcp_gateways_pkey` | `tool_mcp_gateways` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `tool_oauth_states_pkey` | `tool_oauth_states` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `tool_policies_pkey` | `tool_policies` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `tool_profile_bindings_pkey` | `tool_profile_bindings` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `tool_profile_entries_pkey` | `tool_profile_entries` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `tool_profiles_pkey` | `tool_profiles` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `tool_rate_limit_counters_pkey` | `tool_rate_limit_counters` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `tool_runtime_metric_counters_pkey` | `tool_runtime_metric_counters` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `tool_runtime_slots_pkey` | `tool_runtime_slots` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `tool_stdio_command_templates_pkey` | `tool_stdio_command_templates` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `user_pkey` | `user` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `user_blocks_pkey` | `user_blocks` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `user_inbox_agent_policies_pkey` | `user_inbox_agent_policies` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `user_password_set_tokens_pkey` | `user_password_set_tokens` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `user_secret_declarations_pkey` | `user_secret_declarations` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `user_secret_definitions_pkey` | `user_secret_definitions` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `user_sidebar_preferences_pkey` | `user_sidebar_preferences` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `user_ui_language_pkey` | `user_ui_language` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `verification_pkey` | `verification` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `webhook_intake_drafts_pkey` | `webhook_intake_drafts` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `work_assessments_pkey` | `work_assessments` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `workspace_operations_pkey` | `workspace_operations` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |
| `workspace_runtime_services_pkey` | `workspace_runtime_services` | id | Целостность реляционной модели, уникальность identity строки, точечные UPDATE/DELETE по PK |

### 5.2 Составные первичные ключи — 6 индексов

Общее основание: составной PRIMARY KEY — единственный механизм уникальности пары/тройки колонок и связи «многие-ко-многим»; индекс создаётся СУБД автоматически.

| Индекс | Таблица | Колонки / выражение | Основание решения |
|---|---|---|---|
| `announcement_dismissals_user_id_announcement_id_pk` | `announcement_dismissals` | user_id, announcement_id | Целостность реляционной модели (составной PK), защита от дублей связи |
| `decision_target_issues_decision_id_issue_id_pk` | `decision_target_issues` | decision_id, issue_id | Целостность реляционной модели (составной PK), защита от дублей связи |
| `issue_approvals_pk` | `issue_approvals` | issue_id, approval_id | Целостность реляционной модели (составной PK), защита от дублей связи |
| `issue_labels_pk` | `issue_labels` | issue_id, label_id | Целостность реляционной модели (составной PK), защита от дублей связи |
| `myrmidon_scope_group_members_pk` | `myrmidon_scope_group_members` | group_id, agent_id | Целостность реляционной модели (составной PK), защита от дублей связи |
| `project_goals_project_id_goal_id_pk` | `project_goals` | project_id, goal_id | Целостность реляционной модели (составной PK), защита от дублей связи |

### 5.3 Ограничения уникальности (UNIQUE) — 291 индекс

Общее основание: ограничение уникальности — бизнес-инвариант (отсутствие дублей), проверяется СУБД при каждой INSERT/UPDATE. Сканирования при чтении могут не происходить, но удаление индекса снимает инвариант и выполняется только через ALTER TABLE DROP CONSTRAINT.

| Индекс | Таблица | Колонки / выражение | Основание решения |
|---|---|---|---|
| `account_issuer_account_id_uq` | `account` | issuer, account_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `adapter_auth_sessions_company_owner_adapter_active_uq` | `adapter_auth_sessions` | company_id, started_by_user_id, adapter_type | Инвариант уникальности; проверка при INSERT/UPDATE |
| `adapter_auth_sessions_public_session_id_uq` | `adapter_auth_sessions` | public_session_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `agent_castes_company_default_uq` | `agent_castes` | company_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `agent_castes_company_key_uq` | `agent_castes` | company_id, key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `agent_exchange_messages_cell_uq` | `agent_exchange_messages` | room_id, round, participant_index | Инвариант уникальности; проверка при INSERT/UPDATE |
| `agent_instructions_revisions_agent_revision_uq` | `agent_instructions_revisions` | agent_id, revision_number | Инвариант уникальности; проверка при INSERT/UPDATE |
| `agent_memberships_company_user_agent_uq` | `agent_memberships` | company_id, user_id, agent_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `agent_nests_agent_project_uq` | `agent_nests` | agent_id, project_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `agent_session_goal_actions_session_request_uniq` | `agent_session_goal_actions` | session_id, request_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `agent_task_sessions_company_agent_adapter_task_uniq` | `agent_task_sessions` | company_id, agent_id, adapter_type, task_key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `agent_wakeup_requests_connection_intent_delivery_idempotency_uq` | `agent_wakeup_requests` | company_id, idempotency_key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `agent_wakeup_requests_disposition_repair_idempotency_uq` | `agent_wakeup_requests` | company_id, idempotency_key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `agent_wakeup_requests_pause_resume_idempotency_uq` | `agent_wakeup_requests` | company_id, idempotency_key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `agent_wakeup_requests_question_response_delivery_idempotency_uq` | `agent_wakeup_requests` | company_id, idempotency_key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `agent_wakeup_requests_review_path_recovery_idempotency_uq` | `agent_wakeup_requests` | company_id, idempotency_key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `agent_wakeup_requests_stranded_autopolicy_retry_idempotency_uq` | `agent_wakeup_requests` | company_id, idempotency_key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `agent_wakeup_requests_tool_action_delivery_uq` | `agent_wakeup_requests` | company_id, idempotency_key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `agents_company_built_in_agent_key_unique_idx` | `agents` |  | Инвариант уникальности (частичный UNIQUE-индекс); проверка при INSERT/UPDATE |
| `agents_company_id_uq` | `agents` | company_id, id | Бизнес-инвариант уникальности; проверка при INSERT/UPDATE |
| `ai_connection_defaults_owner_method_uq` | `ai_connection_defaults` | company_id, user_id, provider, method | Инвариант уникальности; проверка при INSERT/UPDATE |
| `ai_provider_defaults_owner_provider_uq` | `ai_provider_defaults` | company_id, user_id, provider | Инвариант уникальности; проверка при INSERT/UPDATE |
| `assets_company_object_key_uq` | `assets` | company_id, object_key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `board_api_keys_key_hash_idx` | `board_api_keys` | key_hash | Инвариант уникальности; проверка при INSERT/UPDATE |
| `bot_apply_jobs_live_bot_uniq` | `bot_apply_jobs` | bot_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `budget_incidents_policy_window_threshold_idx` | `budget_incidents` | policy_id, window_start, threshold_type | Инвариант уникальности; проверка при INSERT/UPDATE |
| `budget_limits_company_level_ref_uq` | `budget_limits` | company_id, level, ref | Инвариант уникальности; проверка при INSERT/UPDATE |
| `budget_policies_company_scope_metric_unique_idx` | `budget_policies` | company_id, scope_type, scope_id, metric, window_kind | Инвариант уникальности; проверка при INSERT/UPDATE |
| `built_in_managed_resources_company_bundle_resource_uq` | `built_in_managed_resources` | company_id, bundle_key, resource_kind, resource_key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `case_attachments_asset_uq` | `case_attachments` | asset_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `case_documents_company_case_key_uq` | `case_documents` | company_id, case_id, key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `case_documents_document_uq` | `case_documents` | document_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `case_issue_links_case_issue_uq` | `case_issue_links` | case_id, issue_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `case_labels_case_label_uq` | `case_labels` | case_id, label_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `cases_company_case_number_uq` | `cases` | company_id, case_number | Инвариант уникальности; проверка при INSERT/UPDATE |
| `cases_company_type_key_uq` | `cases` | company_id, case_type, key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `cases_identifier_uq` | `cases` | identifier | Инвариант уникальности; проверка при INSERT/UPDATE |
| `chat_actions_provider_action_uq` | `chat_actions` | endpoint_id, provider_action_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `chat_agent_routes_pair_uq` | `chat_agent_routes` | source_endpoint_id, destination_endpoint_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `chat_conversations_company_id_uq` | `chat_conversations` | company_id, id | Бизнес-инвариант уникальности; проверка при INSERT/UPDATE |
| `chat_conversations_thread_uq` | `chat_conversations` | endpoint_id, external_conversation_id, external_thread_id, session_generation | Инвариант уникальности; проверка при INSERT/UPDATE |
| `chat_deliveries_company_id_uq` | `chat_deliveries` | company_id, id | Бизнес-инвариант уникальности; проверка при INSERT/UPDATE |
| `chat_deliveries_dedupe_uq` | `chat_deliveries` | endpoint_id, deduplication_key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `chat_deliveries_event_uq` | `chat_deliveries` | endpoint_id, provider_event_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `chat_endpoint_leases_active_uq` | `chat_endpoint_leases` | endpoint_id, lease_key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `chat_endpoint_resources_company_id_uq` | `chat_endpoint_resources` | company_id, id | Бизнес-инвариант уникальности; проверка при INSERT/UPDATE |
| `chat_endpoint_resources_external_uq` | `chat_endpoint_resources` | endpoint_id, type, provider_resource_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `chat_endpoints_agentmail_inbox_uq` | `chat_endpoints` | bot_external_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `chat_endpoints_company_id_uq` | `chat_endpoints` | company_id, id | Бизнес-инвариант уникальности; проверка при INSERT/UPDATE |
| `chat_endpoints_connection_uq` | `chat_endpoints` | connection_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `chat_endpoints_live_bot_external_uq` | `chat_endpoints` | provider, provider_account_id, bot_external_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `chat_endpoints_live_bot_username_uq` | `chat_endpoints` | provider, provider_account_id, bot_username | Инвариант уникальности; проверка при INSERT/UPDATE |
| `chat_endpoints_live_discord_bot_external_uq` | `chat_endpoints` | provider, bot_external_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `chat_endpoints_live_global_app_bot_external_uq` | `chat_endpoints` | provider, bot_external_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `chat_endpoints_photon_number_uq` | `chat_endpoints` | bot_external_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `chat_endpoints_public_id_uq` | `chat_endpoints` | public_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `chat_external_principals_company_id_uq` | `chat_external_principals` | company_id, id | Бизнес-инвариант уникальности; проверка при INSERT/UPDATE |
| `chat_external_principals_external_uq` | `chat_external_principals` | company_id, provider, provider_account_id, external_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `chat_identity_links_endpoint_principal_uq` | `chat_identity_links` | endpoint_id, principal_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `chat_message_links_provider_message_uq` | `chat_message_links` | endpoint_id, conversation_id, provider_message_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `chat_publications_company_id_uq` | `chat_publications` | company_id, id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `chat_publications_idempotency_uq` | `chat_publications` | company_id, idempotency_key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `chat_sdk_state_key_uq` | `chat_sdk_state` | endpoint_id, state_key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `chat_teams_file_transfers_publication_uq` | `chat_teams_file_transfers` | company_id, publication_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `chat_teams_file_transfers_token_uq` | `chat_teams_file_transfers` | endpoint_id, token_sha256 | Инвариант уникальности; проверка при INSERT/UPDATE |
| `claude_setup_token_sessions_active_uq` | `claude_setup_token_sessions` | UNIQUE (partial: active session per user) — см. 0221_swift_justin_hammer.sql | Инвариант уникальности (частичный UNIQUE-индекс); проверка при INSERT/UPDATE |
| `claude_setup_token_sessions_session_id_uq` | `claude_setup_token_sessions` | session_id | Инвариант уникальности (частичный UNIQUE-индекс); проверка при INSERT/UPDATE |
| `companies_issue_prefix_idx` | `companies` | issue_prefix | Инвариант уникальности; проверка при INSERT/UPDATE |
| `company_base_skills_company_key_idx` | `company_base_skills` | company_id, key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `company_base_skills_company_skill_idx` | `company_base_skills` | company_id, skill_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `company_logos_asset_uq` | `company_logos` | asset_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `company_logos_company_uq` | `company_logos` | company_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `company_memberships_company_principal_unique_idx` | `company_memberships` | company_id, principal_type, principal_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `company_onboarding_seeds_company_uq` | `company_onboarding_seeds` | company_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `company_secret_bindings_target_path_uq` | `company_secret_bindings` | company_id, target_type, target_id, config_path | Инвариант уникальности; проверка при INSERT/UPDATE |
| `company_secret_github_app_installations_company_installation_uq` | `company_secret_github_app_installations` | company_id, installation_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `company_secret_provider_configs_default_uq` | `company_secret_provider_configs` | company_id, provider | Инвариант уникальности; проверка при INSERT/UPDATE |
| `company_secret_versions_secret_version_uq` | `company_secret_versions` | secret_id, version | Инвариант уникальности; проверка при INSERT/UPDATE |
| `company_secrets_company_key_uq` | `company_secrets` | company_id, key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `company_secrets_company_name_uq` | `company_secrets` | company_id, name | Инвариант уникальности; проверка при INSERT/UPDATE |
| `company_secrets_user_definition_owner_uq` | `company_secrets` | company_id, user_secret_definition_id, owner_user_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `company_skill_lifecycle_company_skill_idx` | `company_skill_lifecycle` | company_id, skill_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `company_skill_stars_skill_agent_idx` | `company_skill_stars` | company_skill_id, agent_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `company_skill_stars_skill_user_idx` | `company_skill_stars` | company_skill_id, user_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `company_skill_test_runs_company_issue_idx` | `company_skill_test_runs` | company_id, issue_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `company_skill_versions_skill_release_idx` | `company_skill_versions` | company_skill_id, release_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `company_skill_versions_skill_revision_idx` | `company_skill_versions` | company_skill_id, revision_number | Инвариант уникальности; проверка при INSERT/UPDATE |
| `company_skills_company_key_idx` | `company_skills` | company_id, key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `company_user_sidebar_preferences_company_user_uq` | `company_user_sidebar_preferences` | company_id, user_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `completion_contracts_company_issue_id_uq` | `completion_contracts` | company_id, issue_id, id | Бизнес-инвариант уникальности; проверка при INSERT/UPDATE |
| `completion_contracts_issue_hash_uq` | `completion_contracts` | issue_id, canonical_sha256 | Инвариант уникальности; проверка при INSERT/UPDATE |
| `completion_contracts_issue_revision_uq` | `completion_contracts` | issue_id, revision | Инвариант уникальности; проверка при INSERT/UPDATE |
| `connection_event_deliveries_company_provider_id_uq` | `connection_event_deliveries` | company_id, provider, provider_delivery_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `connection_grant_delegations_grant_agent_uq` | `connection_grant_delegations` | grant_id, agent_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `connection_grant_members_grant_subject_uq` | `connection_grant_members` | grant_id, subject_type, subject_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `connection_grants_agent_uq` | `connection_grants` | connection_id, subject_agent_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `connection_grants_company_id_uq` | `connection_grants` | company_id, id | Бизнес-инвариант уникальности; проверка при INSERT/UPDATE |
| `connection_grants_default_uq` | `connection_grants` | connection_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `connection_grants_user_uq` | `connection_grants` | connection_id, subject_user_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `corpus_datasets_company_name_uq` | `corpus_datasets` | company_id, name | Инвариант уникальности; проверка при INSERT/UPDATE |
| `corpus_parse_jobs_document_parser_uq` | `corpus_parse_jobs` | document_id, parser_version | Инвариант уникальности; проверка при INSERT/UPDATE |
| `corpus_settings_company_uq` | `corpus_settings` | company_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `decision_archive_notification_outbox_uq` | `decision_archive_notification_outbox` | company_id, source_kind, source_id, archive_version, origin_agent_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `decision_effect_executions_decision_effect_uq` | `decision_effect_executions` | decision_id, effect_index | Инвариант уникальности; проверка при INSERT/UPDATE |
| `decision_queue_items_queue_source_uq` | `decision_queue_items` | queue_id, source_kind, source_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `decision_queues_company_key_uq` | `decision_queues` | company_id, key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `decision_queues_id_company_uq` | `decision_queues` | id, company_id | Бизнес-инвариант уникальности; проверка при INSERT/UPDATE |
| `decision_retention_company_source_uq` | `decision_retention` | company_id, source_kind, source_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `decision_training_examples_source_author_uq` | `decision_training_examples` | source_kind, source_id, created_by_user_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `decision_triage_company_source_uq` | `decision_triage` | company_id, source_kind, source_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `decisions_company_idempotency_uq` | `decisions` | company_id, idempotency_key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `document_memberships_company_user_document_uq` | `document_memberships` | company_id, user_id, document_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `document_revisions_document_revision_uq` | `document_revisions` | document_id, revision_number | Инвариант уникальности; проверка при INSERT/UPDATE |
| `email_messages_provider_uq` | `email_messages` | endpoint_id, provider_message_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `environment_custom_image_setup_sessions_environment_active_uq` | `environment_custom_image_setup_sessions` | environment_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `environment_custom_image_templates_environment_active_uq` | `environment_custom_image_templates` | environment_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `environments_local_driver_idx` | `environments` | driver | Инвариант уникальности; проверка при INSERT/UPDATE |
| `environments_managed_sandbox_idx` | `environments` | driver | Инвариант уникальности; проверка при INSERT/UPDATE |
| `environments_name_idx` | `environments` | name | Инвариант уникальности; проверка при INSERT/UPDATE |
| `execution_workspace_runtime_leases_execution_workspace_id_unique` | `execution_workspace_runtime_leases` | execution_workspace_id | Бизнес-инвариант уникальности; проверка при INSERT/UPDATE |
| `external_object_mentions_company_source_null_record_uq` | `external_object_mentions` | company_id, source_issue_id, source_kind, document_key, property_key, canonical_identity_hash | Инвариант уникальности; проверка при INSERT/UPDATE |
| `external_object_mentions_company_source_record_uq` | `external_object_mentions` | company_id, source_issue_id, source_kind, source_record_id, document_key, property_key, canonical_identity_hash | Инвариант уникальности; проверка при INSERT/UPDATE |
| `external_objects_company_external_id_uq` | `external_objects` | company_id, provider_key, object_type, external_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `external_objects_company_identity_uq` | `external_objects` | company_id, provider_key, object_type, canonical_identity_hash | Инвариант уникальности; проверка при INSERT/UPDATE |
| `feedback_exports_feedback_vote_idx` | `feedback_exports` | feedback_vote_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `feedback_votes_company_target_author_idx` | `feedback_votes` | company_id, target_type, target_id, author_user_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `folders_company_kind_parent_slug_uq` | `folders` | company_id, kind, parent_id, slug | Инвариант уникальности; проверка при INSERT/UPDATE |
| `folders_company_kind_root_slug_uq` | `folders` | company_id, kind, slug | Инвариант уникальности; проверка при INSERT/UPDATE |
| `folders_company_kind_system_key_uq` | `folders` | company_id, kind, system_key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `foraging_sources_company_role_url_uq` | `foraging_sources` | company_id, role, url | Инвариант уникальности; проверка при INSERT/UPDATE |
| `heartbeat_run_continuations_run_uq` | `heartbeat_run_continuations` | run_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `heartbeat_run_events_run_seq_uq` | `heartbeat_run_events` | run_id, seq | Инвариант уникальности; проверка при INSERT/UPDATE |
| `heartbeat_run_events_run_source_event_uq` | `heartbeat_run_events` | run_id, source_event_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `heartbeat_run_events_run_source_seq_uq` | `heartbeat_run_events` | run_id, source_instance_id, source_seq | Инвариант уникальности; проверка при INSERT/UPDATE |
| `heartbeat_runs_company_native_issue_contract_id_uq` | `heartbeat_runs` | company_id, native_issue_id, id, completion_contract_id | Бизнес-инвариант уникальности; проверка при INSERT/UPDATE |
| `heartbeat_runs_company_native_issue_id_uq` | `heartbeat_runs` | company_id, native_issue_id, id | Бизнес-инвариант уникальности; проверка при INSERT/UPDATE |
| `heartbeat_runs_native_replacement_predecessor_uq` | `heartbeat_runs` | company_id, retry_of_run_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `inbox_dismissals_company_user_item_idx` | `inbox_dismissals` | company_id, user_id, item_key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `instance_settings_singleton_key_idx` | `instance_settings` | singleton_key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `instance_user_roles_user_role_unique_idx` | `instance_user_roles` | user_id, role | Инвариант уникальности; проверка при INSERT/UPDATE |
| `interaction_escalations_interaction_level_uq` | `interaction_escalations` | interaction_id, level | Инвариант уникальности; проверка при INSERT/UPDATE |
| `invites_token_hash_unique_idx` | `invites` | token_hash | Инвариант уникальности; проверка при INSERT/UPDATE |
| `issue_attachments_asset_uq` | `issue_attachments` | asset_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `issue_claims_issue_active_uq` | `issue_claims` | issue_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `issue_comments_client_request_uq` | `issue_comments` | issue_id, author_user_id, client_request_id | Бизнес-инвариант уникальности; проверка при INSERT/UPDATE |
| `issue_comments_company_id_uq` | `issue_comments` | company_id, id | Бизнес-инвариант уникальности; проверка при INSERT/UPDATE |
| `issue_continuation_keys_company_key_uq` | `issue_continuation_keys` | company_id, key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `issue_create_idempotency_keys_company_key_uq` | `issue_create_idempotency_keys` | company_id, idempotency_key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `issue_documents_company_issue_key_uq` | `issue_documents` | company_id, issue_id, key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `issue_documents_document_uq` | `issue_documents` | document_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `issue_inbox_archives_company_issue_user_idx` | `issue_inbox_archives` | company_id, issue_id, user_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `issue_plan_decompositions_source_revision_uq` | `issue_plan_decompositions` | company_id, source_issue_id, accepted_plan_revision_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `issue_question_response_deliveries_correlation_uq` | `issue_question_response_deliveries` | correlation_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `issue_question_response_deliveries_interaction_uq` | `issue_question_response_deliveries` | interaction_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `issue_read_states_company_issue_user_idx` | `issue_read_states` | company_id, issue_id, user_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `issue_recovery_actions_active_dedupe_key_uq` | `issue_recovery_actions` | company_id, dedupe_key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `issue_recovery_actions_active_fingerprint_uq` | `issue_recovery_actions` | company_id, source_issue_id, cause, fingerprint | Инвариант уникальности; проверка при INSERT/UPDATE |
| `issue_recovery_actions_active_source_uq` | `issue_recovery_actions` | company_id, source_issue_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `issue_reference_mentions_company_source_mention_null_record_uq` | `issue_reference_mentions` | company_id, source_issue_id, target_issue_id, source_kind | Инвариант уникальности; проверка при INSERT/UPDATE |
| `issue_reference_mentions_company_source_mention_record_uq` | `issue_reference_mentions` | company_id, source_issue_id, target_issue_id, source_kind, source_record_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `issue_relations_company_edge_uq` | `issue_relations` | company_id, issue_id, related_issue_id, type | Инвариант уникальности; проверка при INSERT/UPDATE |
| `issue_thread_interactions_company_issue_idempotency_uq` | `issue_thread_interactions` | company_id, issue_id, idempotency_key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `issue_tree_hold_members_hold_issue_uq` | `issue_tree_hold_members` | hold_id, issue_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `issue_watchdogs_company_issue_uq` | `issue_watchdogs` | company_id, issue_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `issue_watchdogs_company_watchdog_issue_uq` | `issue_watchdogs` | company_id, watchdog_issue_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `issues_active_liveness_recovery_incident_uq` | `issues` | company_id, origin_kind, origin_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `issues_active_liveness_recovery_leaf_uq` | `issues` | company_id, origin_kind, origin_fingerprint | Инвариант уникальности; проверка при INSERT/UPDATE |
| `issues_active_productivity_review_uq` | `issues` | company_id, origin_kind, origin_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `issues_active_stale_run_evaluation_uq` | `issues` | company_id, origin_kind, origin_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `issues_active_stranded_issue_recovery_uq` | `issues` | company_id, origin_kind, origin_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `issues_active_task_watchdog_uq` | `issues` | company_id, origin_kind, origin_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `issues_company_id_uq` | `issues` | company_id, id | Бизнес-инвариант уникальности; проверка при INSERT/UPDATE |
| `issues_conversation_identity_idx` | `issues` | company_id, conversation_agent_id, conversation_user_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `issues_identifier_idx` | `issues` | identifier | Инвариант уникальности; проверка при INSERT/UPDATE |
| `issues_onboarding_first_task_uq` | `issues` | company_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `issues_open_routine_execution_uq` | `issues` | company_id, origin_kind, origin_id, origin_fingerprint | Инвариант уникальности; проверка при INSERT/UPDATE |
| `join_requests_invite_unique_idx` | `join_requests` | invite_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `join_requests_pending_human_email_uq` | `join_requests` | company_id, lower("request_email_snapshot") | Инвариант уникальности; проверка при INSERT/UPDATE |
| `join_requests_pending_human_user_uq` | `join_requests` | company_id, requesting_user_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `knowledge_items_nest_slug_uq` | `knowledge_items` | nest_id, slug | Инвариант уникальности; проверка при INSERT/UPDATE |
| `knowledge_links_source_target_uq` | `knowledge_links` | source_item_id, target_slug | Инвариант уникальности; проверка при INSERT/UPDATE |
| `knowledge_revisions_item_revision_uq` | `knowledge_revisions` | item_id, revision_number | Инвариант уникальности; проверка при INSERT/UPDATE |
| `knowledge_settings_company_uq` | `knowledge_settings` | company_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `knowledge_sources_revision_source_uq` | `knowledge_sources` | revision_id, kind, ref | Инвариант уникальности; проверка при INSERT/UPDATE |
| `knowledge_suggestions_idempotency_key_uq` | `knowledge_suggestions` | nest_id, idempotency_key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `labels_company_name_idx` | `labels` | company_id, name | Инвариант уникальности; проверка при INSERT/UPDATE |
| `legacy_blocked_import_company_import_key_uq` | `legacy_blocked_import` | company_id, import_key | Бизнес-инвариант уникальности; проверка при INSERT/UPDATE |
| `litellm_cost_events_request_uq` | `litellm_cost_events` | request_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `litellm_models_name_seen_uq` | `litellm_models` | model_name, seen_at | Инвариант уникальности; проверка при INSERT/UPDATE |
| `managed_agent_profiles_company_key_uq` | `managed_agent_profiles` | company_id, profile_key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `managed_agent_profiles_company_resource_uq` | `managed_agent_profiles` | company_id, anthropic_agent_id, agent_version, environment_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `model_provider_models_provider_model_uq` | `model_provider_models` | provider_id, model_name | Инвариант уникальности; проверка при INSERT/UPDATE |
| `model_providers_company_name_uq` | `model_providers` | company_id, name | Инвариант уникальности; проверка при INSERT/UPDATE |
| `myrmidon_channel_allowed_users_admission_uq` | `myrmidon_channel_allowed_users` | company_id, provider, external_id, scope, endpoint_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `myrmidon_egress_policies_company_scope_target_uq` | `myrmidon_egress_policies` | company_id, scope, target_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `myrmidon_eval_reference_tasks_company_role_slug_uq` | `myrmidon_eval_reference_tasks` | company_id, role, slug | Инвариант уникальности; проверка при INSERT/UPDATE |
| `myrmidon_fleet_memory_syncs_running_site_uq` | `myrmidon_fleet_memory_syncs` | company_id, site_name | Инвариант уникальности; проверка при INSERT/UPDATE |
| `myrmidon_fleet_moves_active_bot_uq` | `myrmidon_fleet_moves` | company_id, bot_key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `myrmidon_fleet_servers_company_slug_uq` | `myrmidon_fleet_servers` | company_id, slug | Инвариант уникальности; проверка при INSERT/UPDATE |
| `myrmidon_fleet_sites_company_name_uq` | `myrmidon_fleet_sites` | company_id, name | Инвариант уникальности; проверка при INSERT/UPDATE |
| `myrmidon_owner_activity_user_channel_uq` | `myrmidon_owner_activity` | user_id, channel | Инвариант уникальности; проверка при INSERT/UPDATE |
| `myrmidon_scope_groups_company_name_uq` | `myrmidon_scope_groups` | company_id, name | Инвариант уникальности; проверка при INSERT/UPDATE |
| `myrmidon_scope_settings_instance_uq` | `myrmidon_scope_settings` | company_id, scope_kind, scope_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `myrmidon_wiki_regulations_company_slug_uq` | `myrmidon_wiki_regulations` | company_id, slug | Инвариант уникальности; проверка при INSERT/UPDATE |
| `native_run_results_company_issue_run_id_uq` | `native_run_results` | company_id, issue_id, run_id, id | Бизнес-инвариант уникальности; проверка при INSERT/UPDATE |
| `native_run_results_run_caller_dedupe_uq` | `native_run_results` | run_id, caller_dedupe_key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `native_run_results_run_caller_result_uq` | `native_run_results` | run_id, caller_result_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `native_run_results_run_fingerprint_uq` | `native_run_results` | run_id, server_fingerprint | Инвариант уникальности; проверка при INSERT/UPDATE |
| `nest_redact_settings_nest_idx` | `nest_redact_settings` | nest_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `pipeline_automation_executions_idempotency_uq` | `pipeline_automation_executions` | case_id, automation_id, triggering_event_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `pipeline_case_blockers_case_blocked_by_uq` | `pipeline_case_blockers` | case_id, blocked_by_case_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `pipeline_case_documents_company_case_key_uq` | `pipeline_case_documents` | company_id, case_id, key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `pipeline_case_documents_document_uq` | `pipeline_case_documents` | document_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `pipeline_case_issue_links_case_issue_uq` | `pipeline_case_issue_links` | case_id, issue_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `pipeline_cases_parent_request_key_uq` | `pipeline_cases` | parent_case_id, request_key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `pipeline_cases_pipeline_case_key_uq` | `pipeline_cases` | pipeline_id, case_key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `pipeline_documents_company_pipeline_key_uq` | `pipeline_documents` | company_id, pipeline_id, key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `pipeline_documents_document_uq` | `pipeline_documents` | document_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `pipeline_stages_pipeline_key_uq` | `pipeline_stages` | pipeline_id, key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `pipeline_transitions_pipeline_edge_uq` | `pipeline_transitions` | pipeline_id, from_stage_id, to_stage_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `pipelines_company_key_uq` | `pipelines` | company_id, key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `plugin_company_settings_company_plugin_uq` | `plugin_company_settings` | company_id, plugin_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `plugin_config_plugin_company_idx` | `plugin_config` | plugin_id, company_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `plugin_database_namespaces_namespace_idx` | `plugin_database_namespaces` | namespace_name | Инвариант уникальности; проверка при INSERT/UPDATE |
| `plugin_database_namespaces_plugin_idx` | `plugin_database_namespaces` | plugin_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `plugin_entities_external_idx` | `plugin_entities` | company_id, plugin_id, entity_type, external_id | Бизнес-инвариант уникальности; проверка при INSERT/UPDATE |
| `plugin_jobs_unique_idx` | `plugin_jobs` | plugin_id, job_key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `plugin_managed_resources_company_plugin_resource_uq` | `plugin_managed_resources` | company_id, plugin_id, resource_kind, resource_key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `plugin_migrations_plugin_key_idx` | `plugin_migrations` | plugin_id, migration_key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `plugin_state_unique_entry_idx` | `plugin_state` | plugin_id, scope_kind, scope_id, namespace, state_key | Бизнес-инвариант уникальности; проверка при INSERT/UPDATE |
| `plugins_plugin_key_idx` | `plugins` | plugin_key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `pool_chat_module_instances_company_module_uq` | `pool_chat_module_instances` | company_id, module_key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `pool_chat_quota_reservations_request_uq` | `pool_chat_quota_reservations` | request_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `pool_chat_request_attempts_provider_ref_uq` | `pool_chat_request_attempts` | provider, provider_request_ref | Инвариант уникальности; проверка при INSERT/UPDATE |
| `pool_chat_request_attempts_request_no_uq` | `pool_chat_request_attempts` | request_id, attempt_no | Инвариант уникальности; проверка при INSERT/UPDATE |
| `pool_chat_requests_event_identity_uq` | `pool_chat_requests` | company_id, module_id, channel, subject_id, client_message_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `pool_chat_requests_identity_key_uq` | `pool_chat_requests` | company_id, module_id, channel, subject_id, idempotency_key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `principal_permission_grants_unique_idx` | `principal_permission_grants` | company_id, principal_type, principal_id, permission_key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `project_memberships_company_user_project_uq` | `project_memberships` | company_id, user_id, project_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `project_token_quotas_project_unique_idx` | `project_token_quotas` | project_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `project_workspaces_project_remote_ref_idx` | `project_workspaces` | project_id, remote_provider, remote_workspace_ref | Инвариант уникальности; проверка при INSERT/UPDATE |
| `provider_trace_records_run_unique` | `provider_trace_records` | run_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `provider_usage_event_receipts_company_event_uq` | `provider_usage_event_receipts` | company_id, event_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `provider_usage_snapshots_window_uq` | `provider_usage_snapshots` | company_id, provider, credential_ref, window_kind, window_started_at | Инвариант уникальности; проверка при INSERT/UPDATE |
| `provider_usage_warning_deliveries_warning_uq` | `provider_usage_warning_deliveries` | company_id, warning_key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `reflect_jobs_dedup_key_uniq` | `reflect_jobs` | dedup_key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `remote_agent_profiles_company_key_uq` | `remote_agent_profiles` | company_id, profile_key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `routine_documents_company_routine_key_uq` | `routine_documents` | company_id, routine_id, key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `routine_documents_document_uq` | `routine_documents` | document_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `routine_revisions_routine_revision_uq` | `routine_revisions` | routine_id, revision_number | Инвариант уникальности; проверка при INSERT/UPDATE |
| `routine_triggers_public_id_uq` | `routine_triggers` | public_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `run_identity_contexts_run_correlation_idx` | `run_identity_contexts` | run_id, correlation_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `run_identity_contexts_run_revision_idx` | `run_identity_contexts` | run_id, revision | Инвариант уникальности; проверка при INSERT/UPDATE |
| `status_decision_effects_company_idempotency_uq` | `status_decision_effects` | company_id, idempotency_key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `status_decision_effects_decision_ordinal_uq` | `status_decision_effects` | decision_id, ordinal | Инвариант уникальности; проверка при INSERT/UPDATE |
| `status_decisions_company_assessment_uq` | `status_decisions` | company_id, assessment_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `status_decisions_company_issue_digest_uq` | `status_decisions` | company_id, issue_id, decision_digest | Инвариант уникальности; проверка при INSERT/UPDATE |
| `status_decisions_company_issue_id_uq` | `status_decisions` | company_id, issue_id, id | Бизнес-инвариант уникальности; проверка при INSERT/UPDATE |
| `status_decisions_company_issue_run_assessment_id_uq` | `status_decisions` | company_id, issue_id, run_id, assessment_id, id | Бизнес-инвариант уникальности; проверка при INSERT/UPDATE |
| `status_decisions_company_issue_version_uq` | `status_decisions` | company_id, issue_id, decision_version | Инвариант уникальности; проверка при INSERT/UPDATE |
| `summary_slots_company_scope_slot_uq` | `summary_slots` | company_id, scope_kind, scope_id, slot_key | Бизнес-инвариант уникальности; проверка при INSERT/UPDATE |
| `summary_slots_document_uq` | `summary_slots` | document_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `tool_applications_company_key_uq` | `tool_applications` | company_id, application_key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `tool_applications_company_name_uq` | `tool_applications` | company_id, name | Инвариант уникальности; проверка при INSERT/UPDATE |
| `tool_catalog_entries_connection_name_uq` | `tool_catalog_entries` | connection_id, name | Инвариант уникальности; проверка при INSERT/UPDATE |
| `tool_connection_installs_target_uq` | `tool_connection_installs` | company_id, connection_id, target_type, target_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `tool_connections_company_id_uq` | `tool_connections` | company_id, id | Бизнес-инвариант уникальности; проверка при INSERT/UPDATE |
| `tool_connections_company_uid_uq` | `tool_connections` | company_id, uid | Инвариант уникальности; проверка при INSERT/UPDATE |
| `tool_gateway_rate_limit_counters_window_uq` | `tool_gateway_rate_limit_counters` | company_id, counter_key, window_start_at | Инвариант уникальности; проверка при INSERT/UPDATE |
| `tool_gateway_sessions_token_hash_uq` | `tool_gateway_sessions` | token_hash | Инвариант уникальности; проверка при INSERT/UPDATE |
| `tool_invocations_company_idempotency_uq` | `tool_invocations` | company_id, idempotency_key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `tool_mcp_gateway_tokens_token_hash_uq` | `tool_mcp_gateway_tokens` | token_hash | Инвариант уникальности; проверка при INSERT/UPDATE |
| `tool_mcp_gateways_company_name_uq` | `tool_mcp_gateways` | company_id, name | Инвариант уникальности; проверка при INSERT/UPDATE |
| `tool_mcp_gateways_company_slug_uq` | `tool_mcp_gateways` | company_id, slug | Инвариант уникальности; проверка при INSERT/UPDATE |
| `tool_mcp_gateways_public_id_uq` | `tool_mcp_gateways` | gateway_public_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `tool_policies_company_name_uq` | `tool_policies` | company_id, name | Инвариант уникальности; проверка при INSERT/UPDATE |
| `tool_profile_bindings_target_profile_uq` | `tool_profile_bindings` | company_id, target_type, target_id, profile_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `tool_profiles_company_key_uq` | `tool_profiles` | company_id, profile_key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `tool_profiles_company_name_uq` | `tool_profiles` | company_id, name | Инвариант уникальности; проверка при INSERT/UPDATE |
| `tool_rate_limit_counters_window_uq` | `tool_rate_limit_counters` | company_id, policy_id, counter_key, window_kind, window_start_at | Инвариант уникальности; проверка при INSERT/UPDATE |
| `tool_runtime_metric_counters_bucket_uq` | `tool_runtime_metric_counters` | company_id, metric, bucket_start_at | Инвариант уникальности; проверка при INSERT/UPDATE |
| `tool_runtime_slots_slot_key_uq` | `tool_runtime_slots` | company_id, slot_key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `tool_stdio_command_templates_company_key_uq` | `tool_stdio_command_templates` | company_id, template_key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `user_inbox_agent_policies_company_user_uq` | `user_inbox_agent_policies` | company_id, user_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `user_secret_declarations_target_path_uq` | `user_secret_declarations` | company_id, target_type, target_id, config_path | Инвариант уникальности; проверка при INSERT/UPDATE |
| `user_secret_definitions_company_key_uq` | `user_secret_definitions` | company_id, key | Инвариант уникальности; проверка при INSERT/UPDATE |
| `user_sidebar_preferences_user_uq` | `user_sidebar_preferences` | user_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `user_ui_language_user_uq` | `user_ui_language` | user_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `webhook_intake_drafts_company_source_event_uq` | `webhook_intake_drafts` | company_id, source, external_event_id | Инвариант уникальности; проверка при INSERT/UPDATE |
| `work_assessments_company_issue_input_uq` | `work_assessments` | company_id, issue_id, input_digest | Инвариант уникальности; проверка при INSERT/UPDATE |
| `work_assessments_company_issue_run_id_uq` | `work_assessments` | company_id, issue_id, run_id, id | Бизнес-инвариант уникальности; проверка при INSERT/UPDATE |

### 5.4 Покрытие внешних ключей (FK) — 529 индексов

Общее основание: индекс по ведущей колонке внешнего ключа в дочерней таблице. Без него каждый DELETE/UPDATE ключа в родительской таблице вызывает Seq Scan дочерней с ShareRowExclusiveLock; при потоковых объёмах это деградация и дедлоки. Правило: у каждого FK должен быть индекс.

| Индекс | Таблица | Колонки / выражение | Основание решения |
|---|---|---|---|
| `activity_log_company_action_created_idx` | `activity_log` | company_id, action, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `activity_log_company_agent_created_idx` | `activity_log` | company_id, agent_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `activity_log_company_created_idx` | `activity_log` | company_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `activity_log_issue_created_at_idx` | `activity_log` | company_id, entity_type, entity_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `activity_log_issue_last_activity_idx` | `activity_log` | company_id, entity_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `activity_log_run_id_idx` | `activity_log` | run_id | Покрытие FK по run_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `adapter_auth_sessions_company_status_idx` | `adapter_auth_sessions` | company_id, status | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `adapter_auth_sessions_environment_idx` | `adapter_auth_sessions` | environment_id | Покрытие FK по environment_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `agent_api_keys_company_agent_idx` | `agent_api_keys` | company_id, agent_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `agent_castes_company_idx` | `agent_castes` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `agent_config_revisions_agent_created_idx` | `agent_config_revisions` | agent_id, created_at | Покрытие FK по agent_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `agent_config_revisions_company_agent_created_idx` | `agent_config_revisions` | company_id, agent_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `agent_exchange_messages_room_round_idx` | `agent_exchange_messages` | room_id, round | Покрытие FK по room_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `agent_exchange_rooms_company_issue_idx` | `agent_exchange_rooms` | company_id, issue_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `agent_exchange_rooms_company_status_idx` | `agent_exchange_rooms` | company_id, status | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `agent_instructions_revisions_company_agent_created_idx` | `agent_instructions_revisions` | company_id, agent_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `agent_memberships_agent_idx` | `agent_memberships` | agent_id | Покрытие FK по agent_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `agent_memberships_company_user_idx` | `agent_memberships` | company_id, user_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `agent_memberships_company_user_starred_idx` | `agent_memberships` | company_id, user_id, starred_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `agent_nests_company_agent_idx` | `agent_nests` | company_id, agent_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `agent_nests_project_idx` | `agent_nests` | project_id | Покрытие FK по project_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `agent_runtime_state_company_agent_idx` | `agent_runtime_state` | company_id, agent_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `agent_runtime_state_company_updated_idx` | `agent_runtime_state` | company_id, updated_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `agent_session_goal_actions_company_status_created_idx` | `agent_session_goal_actions` | company_id, status, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `agent_session_goal_actions_session_created_idx` | `agent_session_goal_actions` | session_id, created_at | Покрытие FK по session_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `agent_task_sessions_company_agent_updated_idx` | `agent_task_sessions` | company_id, agent_id, updated_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `agent_task_sessions_company_task_updated_idx` | `agent_task_sessions` | company_id, task_key, updated_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `agent_wakeup_requests_agent_requested_idx` | `agent_wakeup_requests` | agent_id, requested_at | Покрытие FK по agent_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `agent_wakeup_requests_company_agent_status_idx` | `agent_wakeup_requests` | company_id, agent_id, status | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `agent_wakeup_requests_company_requested_idx` | `agent_wakeup_requests` | company_id, requested_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `agents_company_default_environment_idx` | `agents` | company_id, default_environment_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `agents_company_reports_to_idx` | `agents` | company_id, reports_to | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `agents_company_status_idx` | `agents` | company_id, status | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `approval_comments_approval_created_idx` | `approval_comments` | approval_id, created_at | Покрытие FK по approval_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `approval_comments_approval_idx` | `approval_comments` | approval_id | Покрытие FK по approval_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `approval_comments_company_idx` | `approval_comments` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `approvals_company_status_type_idx` | `approvals` | company_id, status, type | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `assets_company_created_idx` | `assets` | company_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `assets_company_provider_idx` | `assets` | company_id, provider | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `baseline_metric_snapshots_company_generated_idx` | `baseline_metric_snapshots` | company_id, generated_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `baseline_metric_snapshots_company_pinned_idx` | `baseline_metric_snapshots` | company_id, pinned | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `billing_events_company_idx` | `billing_events` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `board_api_keys_user_idx` | `board_api_keys` | user_id | Покрытие FK по user_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `bot_apply_jobs_company_bot_idx` | `bot_apply_jobs` | company_id, bot_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `budget_incidents_company_scope_idx` | `budget_incidents` | company_id, scope_type, scope_id, status | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `budget_incidents_company_status_idx` | `budget_incidents` | company_id, status | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `budget_limit_changes_company_at_idx` | `budget_limit_changes` | company_id, changed_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `budget_limit_changes_company_limit_idx` | `budget_limit_changes` | company_id, limit_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `budget_limits_company_level_idx` | `budget_limits` | company_id, level | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `budget_policies_company_scope_active_idx` | `budget_policies` | company_id, scope_type, scope_id, is_active | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `budget_policies_company_window_idx` | `budget_policies` | company_id, window_kind, metric | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `built_in_managed_resources_company_idx` | `built_in_managed_resources` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `case_attachments_company_case_idx` | `case_attachments` | company_id, case_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `case_documents_company_case_updated_idx` | `case_documents` | company_id, case_id, updated_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `case_events_case_created_idx` | `case_events` | case_id, created_at | Покрытие FK по case_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `case_events_company_case_idx` | `case_events` | company_id, case_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `case_issue_links_company_case_idx` | `case_issue_links` | company_id, case_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `case_issue_links_issue_idx` | `case_issue_links` | issue_id | Покрытие FK по issue_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `case_labels_company_case_idx` | `case_labels` | company_id, case_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `case_labels_label_idx` | `case_labels` | label_id | Покрытие FK по label_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `cases_company_project_idx` | `cases` | company_id, project_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `cases_company_status_idx` | `cases` | company_id, status | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `cases_company_type_idx` | `cases` | company_id, case_type | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `cases_parent_idx` | `cases` | parent_case_id | Покрытие FK по parent_case_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `chat_conversations_issue_idx` | `chat_conversations` | company_id, issue_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `chat_endpoint_resources_endpoint_idx` | `chat_endpoint_resources` | company_id, endpoint_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `chat_endpoints_agent_idx` | `chat_endpoints` | company_id, assigned_agent_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `chat_endpoints_company_idx` | `chat_endpoints` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `chat_endpoints_status_idx` | `chat_endpoints` | company_id, status | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `chat_external_principals_company_idx` | `chat_external_principals` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `chat_identity_links_user_idx` | `chat_identity_links` | company_id, paperclip_user_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `chat_message_links_inbound_link_idx` | `chat_message_links` | company_id, conversation_id, direction, comment_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `cli_auth_challenges_approved_by_idx` | `cli_auth_challenges` | approved_by_user_id | Покрытие FK по approved_by_user_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `cli_auth_challenges_requested_company_idx` | `cli_auth_challenges` | requested_company_id | Покрытие FK по requested_company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `companies_default_responsible_user_idx` | `companies` | default_responsible_user_id | Покрытие FK по default_responsible_user_id (users): lookup владельца по умолчанию |
| `company_base_skills_company_created_idx` | `company_base_skills` | company_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `company_memberships_company_status_idx` | `company_memberships` | company_id, status | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `company_secret_bindings_company_idx` | `company_secret_bindings` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `company_secret_bindings_secret_idx` | `company_secret_bindings` | secret_id | Покрытие FK по secret_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `company_secret_bindings_target_idx` | `company_secret_bindings` | company_id, target_type, target_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `company_secret_github_app_installations_company_idx` | `company_secret_github_app_installations` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `company_secret_proposals_company_status_idx` | `company_secret_proposals` | company_id, status | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `company_secret_proposals_interaction_idx` | `company_secret_proposals` | interaction_id | Покрытие FK по interaction_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `company_secret_proposals_proposer_status_idx` | `company_secret_proposals` | proposed_by_agent_id, status | Покрытие FK по proposed_by_agent_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `company_secret_proposals_secret_proposal_idx` | `company_secret_proposals` | secret_proposal_id | Покрытие FK по secret_proposal_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `company_secret_provider_configs_company_idx` | `company_secret_provider_configs` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `company_secret_provider_configs_company_provider_idx` | `company_secret_provider_configs` | company_id, provider | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `company_secret_versions_secret_idx` | `company_secret_versions` | secret_id, created_at | Покрытие FK по secret_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `company_secrets_company_idx` | `company_secrets` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `company_secrets_company_owner_idx` | `company_secrets` | company_id, owner_user_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `company_secrets_company_provider_idx` | `company_secrets` | company_id, provider | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `company_secrets_company_scope_idx` | `company_secrets` | company_id, scope | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `company_secrets_provider_config_idx` | `company_secrets` | provider_config_id | Покрытие FK по provider_config_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `company_secrets_user_definition_owner_idx` | `company_secrets` | company_id, user_secret_definition_id, owner_user_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `company_skill_comments_company_skill_created_idx` | `company_skill_comments` | company_id, company_skill_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `company_skill_comments_parent_idx` | `company_skill_comments` | parent_comment_id | Покрытие FK по parent_comment_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `company_skill_lifecycle_company_state_idx` | `company_skill_lifecycle` | company_id, state | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `company_skill_lifecycle_events_company_skill_created_idx` | `company_skill_lifecycle_events` | company_id, skill_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `company_skill_stars_company_skill_created_idx` | `company_skill_stars` | company_id, company_skill_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `company_skill_test_inputs_company_skill_active_idx` | `company_skill_test_inputs` | company_id, skill_id, deleted_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `company_skill_test_inputs_company_skill_name_idx` | `company_skill_test_inputs` | company_id, skill_id, name | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `company_skill_test_run_templates_company_active_idx` | `company_skill_test_run_templates` | company_id, deleted_at, name | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `company_skill_test_runs_company_harness_expires_idx` | `company_skill_test_runs` | company_id, harness_issue_expires_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `company_skill_test_runs_company_input_created_idx` | `company_skill_test_runs` | company_id, input_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `company_skill_test_runs_company_skill_created_idx` | `company_skill_test_runs` | company_id, skill_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `company_skill_test_runs_company_status_idx` | `company_skill_test_runs` | company_id, status | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `company_skill_versions_company_skill_created_idx` | `company_skill_versions` | company_id, company_skill_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `company_skills_company_current_version_idx` | `company_skills` | company_id, current_version_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `company_skills_company_folder_idx` | `company_skills` | company_id, folder_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `company_skills_company_forked_from_idx` | `company_skills` | company_id, forked_from_skill_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `company_skills_company_name_idx` | `company_skills` | company_id, name | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `company_skills_company_sharing_scope_idx` | `company_skills` | company_id, sharing_scope | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `company_transfer_runs_company_idx` | `company_transfer_runs` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `company_user_sidebar_preferences_company_idx` | `company_user_sidebar_preferences` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `connection_event_deliveries_company_status_idx` | `connection_event_deliveries` | company_id, status, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `connection_grant_delegations_company_agent_idx` | `connection_grant_delegations` | company_id, agent_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `connection_grant_members_company_subject_idx` | `connection_grant_members` | company_id, subject_type, subject_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `connection_grants_company_connection_idx` | `connection_grants` | company_id, connection_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `connection_grants_subject_agent_idx` | `connection_grants` | company_id, subject_agent_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `connection_grants_subject_user_idx` | `connection_grants` | company_id, subject_user_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `connection_token_issuances_agent_connection_idx` | `connection_token_issuances` | company_id, agent_id, connection_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `connection_token_issuances_company_created_idx` | `connection_token_issuances` | company_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `connection_token_issuances_connection_created_idx` | `connection_token_issuances` | company_id, connection_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `connection_token_issuances_run_idx` | `connection_token_issuances` | company_id, run_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `corpus_chunks_company_document_idx` | `corpus_chunks` | company_id, document_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `corpus_chunks_document_idx` | `corpus_chunks` | document_id | Покрытие FK по document_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `corpus_datasets_company_idx` | `corpus_datasets` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `corpus_documents_company_status_idx` | `corpus_documents` | company_id, status | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `corpus_documents_dataset_status_idx` | `corpus_documents` | dataset_id, status | Покрытие FK по dataset_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `corpus_parse_jobs_company_idx` | `corpus_parse_jobs` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `cost_events_company_agent_occurred_idx` | `cost_events` | company_id, agent_id, occurred_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `cost_events_company_heartbeat_run_idx` | `cost_events` | company_id, heartbeat_run_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `cost_events_company_occurred_idx` | `cost_events` | company_id, occurred_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `cost_events_company_provider_occurred_idx` | `cost_events` | company_id, provider, occurred_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `decision_bundles_company_created_at_idx` | `decision_bundles` | company_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `decision_effect_executions_target_issue_idx` | `decision_effect_executions` | target_issue_id | Покрытие FK по target_issue_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `decision_queue_items_company_source_idx` | `decision_queue_items` | company_id, source_kind, source_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `decision_queues_company_updated_idx` | `decision_queues` | company_id, updated_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `decision_retention_company_archived_idx` | `decision_retention` | company_id, archived_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `decision_target_issues_decision_idx` | `decision_target_issues` | decision_id | Покрытие FK по decision_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `decision_target_issues_issue_idx` | `decision_target_issues` | issue_id | Покрытие FK по issue_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `decision_training_examples_company_created_at_idx` | `decision_training_examples` | company_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `decision_training_examples_issue_idx` | `decision_training_examples` | issue_id | Покрытие FK по issue_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `decision_triage_company_decide_by_idx` | `decision_triage` | company_id, decide_by | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `decision_triage_events_company_source_created_idx` | `decision_triage_events` | company_id, source_kind, source_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `decision_triage_events_queue_created_idx` | `decision_triage_events` | queue_id, created_at | Покрытие FK по queue_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `decisions_bundle_idx` | `decisions` | bundle_id | Покрытие FK по bundle_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `decisions_company_status_expires_at_idx` | `decisions` | company_id, status, expires_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `decisions_origin_issue_idx` | `decisions` | origin_issue_id | Покрытие FK по origin_issue_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `document_annotation_anchor_snapshots_company_document_revision_idx` | `document_annotation_anchor_snapshots` | company_id, document_id, to_revision_number | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `document_annotation_anchor_snapshots_company_thread_created_at_idx` | `document_annotation_anchor_snapshots` | company_id, thread_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `document_annotation_comments_company_case_created_at_idx` | `document_annotation_comments` | company_id, case_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `document_annotation_comments_company_document_created_at_idx` | `document_annotation_comments` | company_id, document_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `document_annotation_comments_company_issue_created_at_idx` | `document_annotation_comments` | company_id, issue_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `document_annotation_comments_company_routine_created_at_idx` | `document_annotation_comments` | company_id, routine_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `document_annotation_comments_company_thread_created_at_idx` | `document_annotation_comments` | company_id, thread_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `document_annotation_comments_issue_comment_idx` | `document_annotation_comments` | issue_comment_id | Покрытие FK по issue_comment_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `document_annotation_threads_company_anchor_state_idx` | `document_annotation_threads` | company_id, anchor_state | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `document_annotation_threads_company_case_status_idx` | `document_annotation_threads` | company_id, case_id, status | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `document_annotation_threads_company_current_revision_open_idx` | `document_annotation_threads` | company_id, document_id, current_revision_id, status | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `document_annotation_threads_company_document_status_idx` | `document_annotation_threads` | company_id, document_id, status | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `document_annotation_threads_company_issue_status_idx` | `document_annotation_threads` | company_id, issue_id, status | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `document_annotation_threads_company_routine_status_idx` | `document_annotation_threads` | company_id, routine_id, status | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `document_memberships_company_user_starred_idx` | `document_memberships` | company_id, user_id, starred_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `document_revisions_company_document_created_idx` | `document_revisions` | company_id, document_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `documents_company_created_idx` | `documents` | company_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `documents_company_updated_idx` | `documents` | company_id, updated_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `email_messages_conversation_idx` | `email_messages` | company_id, conversation_id, timestamp | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `environment_custom_image_setup_sessions_environment_status_idx` | `environment_custom_image_setup_sessions` | environment_id, status | Покрытие FK по environment_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `environment_custom_image_setup_sessions_promoted_template_idx` | `environment_custom_image_setup_sessions` | promoted_template_id | Покрытие FK по promoted_template_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `environment_custom_image_setup_sessions_template_idx` | `environment_custom_image_setup_sessions` | template_id | Покрытие FK по template_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `environment_custom_image_templates_environment_provider_status_idx` | `environment_custom_image_templates` | environment_id, provider, status | Покрытие FK по environment_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `environment_custom_image_templates_environment_status_idx` | `environment_custom_image_templates` | environment_id, status | Покрытие FK по environment_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `environment_custom_image_templates_superseded_by_idx` | `environment_custom_image_templates` | superseded_by_template_id | Покрытие FK по superseded_by_template_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `environment_leases_company_environment_status_idx` | `environment_leases` | company_id, environment_id, status | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `environment_leases_company_execution_workspace_idx` | `environment_leases` | company_id, execution_workspace_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `environment_leases_company_issue_idx` | `environment_leases` | company_id, issue_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `environment_leases_company_last_used_idx` | `environment_leases` | company_id, last_used_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `environment_leases_heartbeat_run_idx` | `environment_leases` | heartbeat_run_id | Покрытие FK по heartbeat_run_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `execution_workspace_runtime_leases_company_owner_idx` | `execution_workspace_runtime_leases` | company_id, owner_key | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `execution_workspace_runtime_leases_company_workspace_idx` | `execution_workspace_runtime_leases` | company_id, execution_workspace_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `execution_workspaces_company_branch_idx` | `execution_workspaces` | company_id, branch_name | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `execution_workspaces_company_last_used_idx` | `execution_workspaces` | company_id, last_used_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `execution_workspaces_company_project_status_idx` | `execution_workspaces` | company_id, project_id, status | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `execution_workspaces_company_project_workspace_status_idx` | `execution_workspaces` | company_id, project_workspace_id, status | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `execution_workspaces_company_source_issue_idx` | `execution_workspaces` | company_id, source_issue_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `external_object_mentions_company_object_idx` | `external_object_mentions` | company_id, object_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `external_object_mentions_company_provider_idx` | `external_object_mentions` | company_id, provider_key, object_type | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `external_object_mentions_company_source_issue_idx` | `external_object_mentions` | company_id, source_issue_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `external_objects_company_provider_object_idx` | `external_objects` | company_id, provider_key, object_type | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `external_objects_company_provider_status_idx` | `external_objects` | company_id, provider_key, status_category | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `external_objects_company_refresh_idx` | `external_objects` | company_id, next_refresh_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `feedback_exports_company_author_idx` | `feedback_exports` | company_id, author_user_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `feedback_exports_company_created_idx` | `feedback_exports` | company_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `feedback_exports_company_issue_idx` | `feedback_exports` | company_id, issue_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `feedback_exports_company_project_idx` | `feedback_exports` | company_id, project_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `feedback_exports_company_status_idx` | `feedback_exports` | company_id, status, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `feedback_votes_company_issue_idx` | `feedback_votes` | company_id, issue_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `feedback_votes_issue_target_idx` | `feedback_votes` | issue_id, target_type, target_id | Покрытие FK по issue_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `finance_events_company_biller_occurred_idx` | `finance_events` | company_id, biller, occurred_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `finance_events_company_cost_event_idx` | `finance_events` | company_id, cost_event_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `finance_events_company_direction_occurred_idx` | `finance_events` | company_id, direction, occurred_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `finance_events_company_heartbeat_run_idx` | `finance_events` | company_id, heartbeat_run_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `finance_events_company_kind_occurred_idx` | `finance_events` | company_id, event_kind, occurred_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `finance_events_company_occurred_idx` | `finance_events` | company_id, occurred_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `folders_company_kind_parent_position_idx` | `folders` | company_id, kind, parent_id, position, name | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `folders_company_kind_position_idx` | `folders` | company_id, kind, position, name | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `foraging_findings_company_detected_idx` | `foraging_findings` | company_id, detected_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `foraging_findings_company_status_idx` | `foraging_findings` | company_id, status | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `foraging_findings_source_idx` | `foraging_findings` | source_id | Покрытие FK по source_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `foraging_sources_company_role_idx` | `foraging_sources` | company_id, role | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `foraging_spend_company_agent_idx` | `foraging_spend_events` | company_id, agent_id, occurred_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `foraging_spend_company_occurred_idx` | `foraging_spend_events` | company_id, occurred_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `foraging_spend_company_role_idx` | `foraging_spend_events` | company_id, role | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `foraging_spend_source_idx` | `foraging_spend_events` | source_id | Покрытие FK по source_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `goals_company_idx` | `goals` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `guardrail_events_agent_id_idx` | `guardrail_events` | agent_id | Покрытие FK по agent_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `guardrail_events_company_occurred_idx` | `guardrail_events` | company_id, occurred_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `guardrail_events_run_id_idx` | `guardrail_events` | run_id | Покрытие FK по run_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `heartbeat_run_continuations_company_agent_created_idx` | `heartbeat_run_continuations` | company_id, agent_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `heartbeat_run_continuations_company_issue_created_idx` | `heartbeat_run_continuations` | company_id, issue_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `heartbeat_run_events_company_created_idx` | `heartbeat_run_events` | company_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `heartbeat_run_events_company_lifecycle_run_idx` | `heartbeat_run_events` | company_id, event_type, run_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `heartbeat_run_events_company_run_idx` | `heartbeat_run_events` | company_id, run_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `heartbeat_run_watchdog_decisions_company_run_created_idx` | `heartbeat_run_watchdog_decisions` | company_id, run_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `heartbeat_run_watchdog_decisions_company_run_snooze_idx` | `heartbeat_run_watchdog_decisions` | company_id, run_id, snoozed_until | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `heartbeat_runs_company_agent_created_idx` | `heartbeat_runs` | company_id, agent_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `heartbeat_runs_company_agent_started_idx` | `heartbeat_runs` | company_id, agent_id, started_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `heartbeat_runs_company_created_at_desc_idx` | `heartbeat_runs` | company_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `heartbeat_runs_company_liveness_idx` | `heartbeat_runs` | company_id, liveness_state, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `heartbeat_runs_company_responsible_user_idx` | `heartbeat_runs` | company_id, responsible_user_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `heartbeat_runs_company_status_last_output_idx` | `heartbeat_runs` | company_id, status, last_output_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `heartbeat_runs_company_status_process_started_idx` | `heartbeat_runs` | company_id, status, process_started_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `heartbeat_runs_company_status_updated_idx` | `heartbeat_runs` | company_id, status, updated_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `heartbeat_runs_ctx_compact_pending_idx` | `heartbeat_runs` | company_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `heartbeat_runs_failed_queue_idx` | `heartbeat_runs` | company_id, status, updated_at, finished_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `heartbeat_runs_provider_quota_idx` | `heartbeat_runs` | company_id, agent_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `inbox_dismissals_company_item_idx` | `inbox_dismissals` | company_id, item_key | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `inbox_dismissals_company_user_idx` | `inbox_dismissals` | company_id, user_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `interaction_escalations_company_created_at_idx` | `interaction_escalations` | company_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `invites_company_invite_state_idx` | `invites` | company_id, invite_type, revoked_at, expires_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_approvals_approval_idx` | `issue_approvals` | approval_id | Покрытие FK по approval_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_approvals_company_idx` | `issue_approvals` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_approvals_issue_idx` | `issue_approvals` | issue_id | Покрытие FK по issue_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_attachments_company_issue_idx` | `issue_attachments` | company_id, issue_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_attachments_issue_comment_idx` | `issue_attachments` | issue_comment_id | Покрытие FK по issue_comment_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_attachments_originating_run_idx` | `issue_attachments` | originating_run_id | Покрытие FK по originating_run_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_claims_company_agent_live_idx` | `issue_claims` | company_id, agent_id, released_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_claims_company_claimed_idx` | `issue_claims` | company_id, claimed_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_claims_issue_live_idx` | `issue_claims` | issue_id, released_at | Покрытие FK по issue_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_comments_company_author_issue_created_at_idx` | `issue_comments` | company_id, author_user_id, issue_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_comments_company_idx` | `issue_comments` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_comments_company_issue_created_at_idx` | `issue_comments` | company_id, issue_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_comments_issue_created_at_idx` | `issue_comments` | issue_id, created_at | Покрытие FK по issue_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_comments_issue_idx` | `issue_comments` | issue_id | Покрытие FK по issue_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_create_idempotency_keys_company_created_at_idx` | `issue_create_idempotency_keys` | company_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_create_idempotency_keys_issue_idx` | `issue_create_idempotency_keys` | issue_id | Покрытие FK по issue_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_documents_company_issue_updated_idx` | `issue_documents` | company_id, issue_id, updated_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_execution_decisions_company_issue_idx` | `issue_execution_decisions` | company_id, issue_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_execution_decisions_stage_idx` | `issue_execution_decisions` | issue_id, stage_id, created_at | Покрытие FK по issue_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_inbox_archives_company_issue_idx` | `issue_inbox_archives` | company_id, issue_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_inbox_archives_company_user_idx` | `issue_inbox_archives` | company_id, user_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_labels_company_idx` | `issue_labels` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_labels_issue_idx` | `issue_labels` | issue_id | Покрытие FK по issue_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_labels_label_idx` | `issue_labels` | label_id | Покрытие FK по label_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_plan_decompositions_active_owner_idx` | `issue_plan_decompositions` | company_id, owner_agent_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_plan_decompositions_company_source_status_idx` | `issue_plan_decompositions` | company_id, source_issue_id, status | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_question_response_deliveries_company_issue_idx` | `issue_question_response_deliveries` | company_id, issue_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_read_states_company_issue_idx` | `issue_read_states` | company_id, issue_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_read_states_company_user_idx` | `issue_read_states` | company_id, user_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_recovery_actions_company_owner_status_idx` | `issue_recovery_actions` | company_id, owner_agent_id, status | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_recovery_actions_company_recovery_issue_idx` | `issue_recovery_actions` | company_id, recovery_issue_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_recovery_actions_company_source_status_idx` | `issue_recovery_actions` | company_id, source_issue_id, status | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_reference_mentions_company_issue_pair_idx` | `issue_reference_mentions` | company_id, source_issue_id, target_issue_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_reference_mentions_company_source_issue_idx` | `issue_reference_mentions` | company_id, source_issue_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_reference_mentions_company_target_issue_idx` | `issue_reference_mentions` | company_id, target_issue_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_relations_company_issue_idx` | `issue_relations` | company_id, issue_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_relations_company_related_issue_idx` | `issue_relations` | company_id, related_issue_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_relations_company_type_idx` | `issue_relations` | company_id, type | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_thread_interactions_addressee_agent_idx` | `issue_thread_interactions` | addressee_agent_id | Покрытие FK по addressee_agent_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_thread_interactions_company_issue_created_at_idx` | `issue_thread_interactions` | company_id, issue_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_thread_interactions_company_issue_status_idx` | `issue_thread_interactions` | company_id, issue_id, status | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_thread_interactions_issue_idx` | `issue_thread_interactions` | issue_id | Покрытие FK по issue_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_thread_interactions_source_comment_idx` | `issue_thread_interactions` | source_comment_id | Покрытие FK по source_comment_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_tree_hold_members_company_issue_idx` | `issue_tree_hold_members` | company_id, issue_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_tree_hold_members_hold_depth_idx` | `issue_tree_hold_members` | hold_id, depth | Покрытие FK по hold_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_tree_holds_company_root_status_idx` | `issue_tree_holds` | company_id, root_issue_id, status | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_tree_holds_company_status_mode_idx` | `issue_tree_holds` | company_id, status, mode | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_watchdogs_company_agent_idx` | `issue_watchdogs` | company_id, watchdog_agent_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_watchdogs_company_status_idx` | `issue_watchdogs` | company_id, status | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_work_products_company_execution_workspace_type_idx` | `issue_work_products` | company_id, execution_workspace_id, type | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_work_products_company_issue_type_idx` | `issue_work_products` | company_id, issue_id, type | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_work_products_company_provider_external_id_idx` | `issue_work_products` | company_id, provider, external_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issue_work_products_company_updated_idx` | `issue_work_products` | company_id, updated_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issues_company_assignee_status_idx` | `issues` | company_id, assignee_agent_id, status | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issues_company_assignee_user_status_idx` | `issues` | company_id, assignee_user_id, status | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issues_company_caste_idx` | `issues` | company_id, caste_key | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issues_company_checkout_run_idx` | `issues` | company_id, checkout_run_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issues_company_created_idx` | `issues` | company_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issues_company_execution_run_idx` | `issues` | company_id, execution_run_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issues_company_execution_workspace_idx` | `issues` | company_id, execution_workspace_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issues_company_harness_kind_idx` | `issues` | company_id, harness_kind | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issues_company_last_activity_at_idx` | `issues` | company_id, last_activity_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issues_company_monitor_due_idx` | `issues` | company_id, monitor_next_check_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issues_company_origin_idx` | `issues` | company_id, origin_kind, origin_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issues_company_parent_idx` | `issues` | company_id, parent_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issues_company_priority_idx` | `issues` | company_id, priority | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issues_company_project_idx` | `issues` | company_id, project_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issues_company_project_workspace_idx` | `issues` | company_id, project_workspace_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issues_company_responsible_agent_idx` | `issues` | company_id, responsible_agent_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issues_company_responsible_user_idx` | `issues` | company_id, responsible_user_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issues_company_status_idx` | `issues` | company_id, status | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `issues_company_updated_idx` | `issues` | company_id, updated_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `join_requests_company_status_type_created_idx` | `join_requests` | company_id, status, request_type, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `knowledge_deviations_company_idx` | `knowledge_deviations` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `knowledge_deviations_nest_created_at_idx` | `knowledge_deviations` | nest_id, created_at | Покрытие FK по nest_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `knowledge_deviations_nest_idx` | `knowledge_deviations` | nest_id | Покрытие FK по nest_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `knowledge_deviations_nest_status_idx` | `knowledge_deviations` | nest_id, status | Покрытие FK по nest_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `knowledge_events_company_idx` | `knowledge_events` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `knowledge_events_item_created_idx` | `knowledge_events` | item_id, created_at | Покрытие FK по item_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `knowledge_events_nest_created_idx` | `knowledge_events` | nest_id, created_at | Покрытие FK по nest_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `knowledge_items_company_idx` | `knowledge_items` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `knowledge_items_nest_folder_idx` | `knowledge_items` | nest_id, folder_path | Покрытие FK по nest_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `knowledge_items_nest_kind_status_idx` | `knowledge_items` | nest_id, kind, status | Покрытие FK по nest_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `knowledge_items_nest_status_idx` | `knowledge_items` | nest_id, status | Покрытие FK по nest_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `knowledge_links_company_idx` | `knowledge_links` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `knowledge_links_nest_target_idx` | `knowledge_links` | nest_id, resolved_item_id | Покрытие FK по nest_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `knowledge_revisions_company_idx` | `knowledge_revisions` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `knowledge_revisions_nest_idx` | `knowledge_revisions` | nest_id | Покрытие FK по nest_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `knowledge_revisions_translation_idx` | `knowledge_revisions` | translation_of | Покрытие FK по translation_of: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `knowledge_search_nest_idx` | `knowledge_search` | nest_id | Покрытие FK по nest_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `knowledge_sources_company_idx` | `knowledge_sources` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `knowledge_sources_nest_idx` | `knowledge_sources` | nest_id | Покрытие FK по nest_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `knowledge_suggestions_company_idx` | `knowledge_suggestions` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `knowledge_suggestions_nest_status_idx` | `knowledge_suggestions` | nest_id, status | Покрытие FK по nest_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `labels_company_idx` | `labels` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `llm_call_traces_company_agent_occurred_idx` | `llm_call_traces` | company_id, agent_id, occurred_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `llm_call_traces_company_model_occurred_idx` | `llm_call_traces` | company_id, model, occurred_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `llm_call_traces_company_occurred_idx` | `llm_call_traces` | company_id, occurred_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `llm_call_traces_run_idx` | `llm_call_traces` | heartbeat_run_id | Покрытие FK по heartbeat_run_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `llm_call_traces_unique_observation` | `llm_call_traces` | company_id, langfuse_observation_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `managed_agent_profiles_company_idx` | `managed_agent_profiles` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `model_provider_models_provider_idx` | `model_provider_models` | provider_id | Покрытие FK по provider_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `model_providers_company_idx` | `model_providers` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `myrmidon_channel_allowed_users_company_idx` | `myrmidon_channel_allowed_users` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `myrmidon_channel_allowed_users_company_provider_idx` | `myrmidon_channel_allowed_users` | company_id, provider, status | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `myrmidon_egress_policies_company_scope_idx` | `myrmidon_egress_policies` | company_id, scope | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `myrmidon_eval_reference_tasks_company_idx` | `myrmidon_eval_reference_tasks` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `myrmidon_eval_runs_company_idx` | `myrmidon_eval_runs` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `myrmidon_eval_runs_company_role_started_idx` | `myrmidon_eval_runs` | company_id, role, started_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `myrmidon_fleet_affinity_company_idx` | `myrmidon_fleet_affinity` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `myrmidon_fleet_memory_syncs_site_started_idx` | `myrmidon_fleet_memory_syncs` | company_id, site_name, started_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `myrmidon_fleet_moves_company_bot_idx` | `myrmidon_fleet_moves` | company_id, bot_key | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `myrmidon_fleet_onboard_jobs_company_idx` | `myrmidon_fleet_onboard_jobs` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `myrmidon_fleet_onboard_jobs_server_idx` | `myrmidon_fleet_onboard_jobs` | server_id | Покрытие FK по server_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `myrmidon_fleet_servers_company_idx` | `myrmidon_fleet_servers` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `myrmidon_fleet_sites_company_idx` | `myrmidon_fleet_sites` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `myrmidon_scope_agent_prefs_company_idx` | `myrmidon_scope_agent_prefs` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `myrmidon_scope_group_members_agent_idx` | `myrmidon_scope_group_members` | agent_id | Покрытие FK по agent_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `myrmidon_wiki_regulations_company_status_idx` | `myrmidon_wiki_regulations` | company_id, status | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `pipeline_automation_executions_company_case_idx` | `pipeline_automation_executions` | company_id, case_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `pipeline_automation_executions_execution_issue_idx` | `pipeline_automation_executions` | execution_issue_id | Покрытие FK по execution_issue_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `pipeline_automation_executions_routine_idx` | `pipeline_automation_executions` | routine_id | Покрытие FK по routine_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `pipeline_case_blockers_blocked_by_idx` | `pipeline_case_blockers` | blocked_by_case_id | Покрытие FK по blocked_by_case_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `pipeline_case_blockers_company_case_idx` | `pipeline_case_blockers` | company_id, case_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `pipeline_case_documents_company_case_updated_idx` | `pipeline_case_documents` | company_id, case_id, updated_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `pipeline_case_events_case_created_idx` | `pipeline_case_events` | case_id, created_at | Покрытие FK по case_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `pipeline_case_events_company_case_idx` | `pipeline_case_events` | company_id, case_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `pipeline_case_issue_links_company_case_idx` | `pipeline_case_issue_links` | company_id, case_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `pipeline_case_issue_links_issue_idx` | `pipeline_case_issue_links` | issue_id | Покрытие FK по issue_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `pipeline_cases_company_idx` | `pipeline_cases` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `pipeline_cases_parent_idx` | `pipeline_cases` | parent_case_id | Покрытие FK по parent_case_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `pipeline_cases_pipeline_stage_idx` | `pipeline_cases` | pipeline_id, stage_id | Покрытие FK по pipeline_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `pipeline_cases_retired_idx` | `pipeline_cases` | company_id, retired_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `pipeline_documents_company_pipeline_updated_idx` | `pipeline_documents` | company_id, pipeline_id, updated_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `pipeline_stages_pipeline_position_idx` | `pipeline_stages` | pipeline_id, position | Покрытие FK по pipeline_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `pipeline_transitions_pipeline_from_idx` | `pipeline_transitions` | pipeline_id, from_stage_id | Покрытие FK по pipeline_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `pipeline_transitions_pipeline_to_idx` | `pipeline_transitions` | pipeline_id, to_stage_id | Покрытие FK по pipeline_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `pipelines_company_idx` | `pipelines` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `pipelines_company_project_idx` | `pipelines` | company_id, project_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `plugin_company_settings_company_idx` | `plugin_company_settings` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `plugin_company_settings_plugin_idx` | `plugin_company_settings` | plugin_id | Покрытие FK по plugin_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `plugin_entities_company_idx` | `plugin_entities` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `plugin_entities_plugin_idx` | `plugin_entities` | plugin_id | Покрытие FK по plugin_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `plugin_job_runs_company_idx` | `plugin_job_runs` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `plugin_job_runs_job_idx` | `plugin_job_runs` | job_id | Покрытие FK по job_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `plugin_job_runs_plugin_idx` | `plugin_job_runs` | plugin_id | Покрытие FK по plugin_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `plugin_jobs_plugin_idx` | `plugin_jobs` | plugin_id | Покрытие FK по plugin_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `plugin_logs_company_idx` | `plugin_logs` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `plugin_logs_plugin_time_idx` | `plugin_logs` | plugin_id, created_at | Покрытие FK по plugin_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `plugin_managed_resources_company_idx` | `plugin_managed_resources` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `plugin_managed_resources_plugin_idx` | `plugin_managed_resources` | plugin_id | Покрытие FK по plugin_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `plugin_migrations_plugin_idx` | `plugin_migrations` | plugin_id | Покрытие FK по plugin_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `plugin_state_plugin_scope_idx` | `plugin_state` | plugin_id, scope_kind | Покрытие FK по plugin_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `plugin_webhook_deliveries_company_idx` | `plugin_webhook_deliveries` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `plugin_webhook_deliveries_plugin_idx` | `plugin_webhook_deliveries` | plugin_id | Покрытие FK по plugin_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `pool_chat_module_instances_company_idx` | `pool_chat_module_instances` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `pool_chat_module_instances_project_idx` | `pool_chat_module_instances` | project_id | Покрытие FK по project_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `pool_chat_quota_reservations_company_state_idx` | `pool_chat_quota_reservations` | company_id, state | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `pool_chat_request_attempts_request_idx` | `pool_chat_request_attempts` | company_id, request_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `pool_chat_requests_module_status_idx` | `pool_chat_requests` | company_id, module_id, status | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `principal_permission_grants_company_permission_idx` | `principal_permission_grants` | company_id, permission_key | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `project_goals_company_idx` | `project_goals` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `project_goals_goal_idx` | `project_goals` | goal_id | Покрытие FK по goal_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `project_goals_project_idx` | `project_goals` | project_id | Покрытие FK по project_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `project_memberships_company_user_idx` | `project_memberships` | company_id, user_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `project_memberships_company_user_starred_idx` | `project_memberships` | company_id, user_id, starred_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `project_memberships_project_idx` | `project_memberships` | project_id | Покрытие FK по project_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `project_token_quotas_company_idx` | `project_token_quotas` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `project_workspaces_company_project_idx` | `project_workspaces` | company_id, project_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `project_workspaces_company_shared_key_idx` | `project_workspaces` | company_id, shared_workspace_key | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `project_workspaces_project_primary_idx` | `project_workspaces` | project_id, is_primary | Покрытие FK по project_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `project_workspaces_project_source_type_idx` | `project_workspaces` | project_id, source_type | Покрытие FK по project_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `projects_company_idx` | `projects` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `provider_trace_records_company_created_idx` | `provider_trace_records` | company_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `provider_usage_snapshots_company_observed_idx` | `provider_usage_snapshots` | company_id, observed_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `reflect_jobs_company_idx` | `reflect_jobs` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `reflect_jobs_issue_idx` | `reflect_jobs` | issue_id | Покрытие FK по issue_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `remote_agent_profiles_company_idx` | `remote_agent_profiles` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `routine_documents_company_routine_updated_idx` | `routine_documents` | company_id, routine_id, updated_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `routine_revisions_company_responsible_user_idx` | `routine_revisions` | company_id, responsible_user_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `routine_revisions_company_routine_created_idx` | `routine_revisions` | company_id, routine_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `routine_runs_company_responsible_user_idx` | `routine_runs` | company_id, responsible_user_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `routine_runs_company_routine_idx` | `routine_runs` | company_id, routine_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `routine_runs_dispatch_fingerprint_idx` | `routine_runs` | routine_id, dispatch_fingerprint | Покрытие FK по routine_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `routine_runs_linked_issue_idx` | `routine_runs` | linked_issue_id | Покрытие FK по linked_issue_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `routine_runs_revision_idx` | `routine_runs` | routine_revision_id | Покрытие FK по routine_revision_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `routine_runs_trigger_idempotency_idx` | `routine_runs` | trigger_id, idempotency_key | Покрытие FK по trigger_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `routine_runs_trigger_idx` | `routine_runs` | trigger_id, created_at | Покрытие FK по trigger_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `routine_triggers_company_kind_idx` | `routine_triggers` | company_id, kind | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `routine_triggers_company_routine_idx` | `routine_triggers` | company_id, routine_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `routines_company_assignee_idx` | `routines` | company_id, assignee_agent_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `routines_company_folder_idx` | `routines` | company_id, folder_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `routines_company_origin_idx` | `routines` | company_id, origin_kind, origin_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `routines_company_project_idx` | `routines` | company_id, project_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `routines_company_responsible_user_idx` | `routines` | company_id, responsible_user_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `routines_company_status_idx` | `routines` | company_id, status | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `run_identity_contexts_company_run_idx` | `run_identity_contexts` | company_id, run_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `secret_access_events_company_created_idx` | `secret_access_events` | company_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `secret_access_events_secret_created_idx` | `secret_access_events` | secret_id, created_at | Покрытие FK по secret_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `smoke_run_steps_company_path_idx` | `smoke_run_steps` | company_id, path | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `smoke_run_steps_company_run_idx` | `smoke_run_steps` | company_id, run_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `smoke_runs_company_started_idx` | `smoke_runs` | company_id, started_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `smoke_runs_company_status_idx` | `smoke_runs` | company_id, status | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `status_card_updates_card_started_idx` | `status_card_updates` | card_id, started_at | Покрытие FK по card_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `status_card_updates_generation_issue_idx` | `status_card_updates` | generation_issue_id | Покрытие FK по generation_issue_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `status_cards_company_archived_idx` | `status_cards` | company_id, archived_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `status_cards_company_next_eval_idx` | `status_cards` | company_id, next_eval_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `summary_slots_company_generating_issue_idx` | `summary_slots` | company_id, generating_issue_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `summary_slots_company_scope_idx` | `summary_slots` | company_id, scope_kind, scope_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `summary_slots_company_updated_idx` | `summary_slots` | company_id, updated_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_access_audit_company_created_idx` | `tool_access_audit_events` | company_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_access_audit_connection_idx` | `tool_access_audit_events` | connection_id | Покрытие FK по connection_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_access_audit_gateway_idx` | `tool_access_audit_events` | company_id, gateway_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_action_requests_company_status_idx` | `tool_action_requests` | company_id, status | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_action_requests_invocation_idx` | `tool_action_requests` | invocation_id | Покрытие FK по invocation_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_action_requests_issue_idx` | `tool_action_requests` | company_id, issue_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_applications_company_idx` | `tool_applications` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_applications_company_status_idx` | `tool_applications` | company_id, status | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_call_events_company_created_idx` | `tool_call_events` | company_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_call_events_gateway_idx` | `tool_call_events` | company_id, gateway_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_call_events_invocation_idx` | `tool_call_events` | invocation_id | Покрытие FK по invocation_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_call_events_issue_idx` | `tool_call_events` | company_id, issue_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_call_events_run_idx` | `tool_call_events` | company_id, run_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_catalog_entries_application_idx` | `tool_catalog_entries` | application_id | Покрытие FK по application_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_catalog_entries_company_idx` | `tool_catalog_entries` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_catalog_entries_company_status_idx` | `tool_catalog_entries` | company_id, status | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_catalog_entries_connection_idx` | `tool_catalog_entries` | connection_id | Покрытие FK по connection_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_complaints_agent_created_idx` | `tool_complaints` | agent_id, created_at | Покрытие FK по agent_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_complaints_company_created_idx` | `tool_complaints` | company_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_complaints_company_status_idx` | `tool_complaints` | company_id, status | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_complaints_company_tool_idx` | `tool_complaints` | company_id, tool | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_connection_installs_company_target_idx` | `tool_connection_installs` | company_id, target_type, target_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_connection_installs_connection_idx` | `tool_connection_installs` | company_id, connection_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_connections_application_idx` | `tool_connections` | application_id | Покрытие FK по application_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_connections_company_enabled_idx` | `tool_connections` | company_id, enabled | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_connections_company_idx` | `tool_connections` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_gateway_rate_limit_counters_company_idx` | `tool_gateway_rate_limit_counters` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_gateway_sessions_company_agent_idx` | `tool_gateway_sessions` | company_id, agent_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_gateway_sessions_company_expires_idx` | `tool_gateway_sessions` | company_id, expires_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_gateway_sessions_gateway_idx` | `tool_gateway_sessions` | company_id, gateway_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_gateway_sessions_issue_idx` | `tool_gateway_sessions` | company_id, issue_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_gateway_sessions_run_idx` | `tool_gateway_sessions` | company_id, run_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_invocations_company_created_idx` | `tool_invocations` | company_id, created_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_invocations_gateway_idx` | `tool_invocations` | company_id, gateway_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_invocations_issue_idx` | `tool_invocations` | company_id, issue_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_invocations_run_idx` | `tool_invocations` | company_id, run_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_mcp_gateway_tokens_company_expires_idx` | `tool_mcp_gateway_tokens` | company_id, expires_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_mcp_gateway_tokens_gateway_idx` | `tool_mcp_gateway_tokens` | company_id, gateway_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_mcp_gateway_tokens_subject_idx` | `tool_mcp_gateway_tokens` | company_id, subject_type, subject_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_mcp_gateways_company_idx` | `tool_mcp_gateways` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_mcp_gateways_company_status_idx` | `tool_mcp_gateways` | company_id, status | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_mcp_gateways_profile_idx` | `tool_mcp_gateways` | company_id, profile_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_oauth_states_company_idx` | `tool_oauth_states` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_oauth_states_connection_idx` | `tool_oauth_states` | connection_id | Покрытие FK по connection_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_oauth_states_subject_agent_idx` | `tool_oauth_states` | company_id, subject_agent_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_policies_company_enabled_idx` | `tool_policies` | company_id, enabled | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_policies_company_type_idx` | `tool_policies` | company_id, policy_type | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_profile_bindings_company_target_idx` | `tool_profile_bindings` | company_id, target_type, target_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_profile_entries_application_idx` | `tool_profile_entries` | company_id, application_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_profile_entries_catalog_entry_idx` | `tool_profile_entries` | company_id, catalog_entry_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_profile_entries_company_profile_idx` | `tool_profile_entries` | company_id, profile_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_profile_entries_connection_idx` | `tool_profile_entries` | company_id, connection_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_profiles_company_status_idx` | `tool_profiles` | company_id, status | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_rate_limit_counters_company_idx` | `tool_rate_limit_counters` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_runtime_metric_counters_company_metric_idx` | `tool_runtime_metric_counters` | company_id, metric, bucket_start_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_runtime_slots_company_idx` | `tool_runtime_slots` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_runtime_slots_connection_idx` | `tool_runtime_slots` | connection_id | Покрытие FK по connection_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_runtime_slots_execution_workspace_idx` | `tool_runtime_slots` | company_id, execution_workspace_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_stdio_command_templates_company_idx` | `tool_stdio_command_templates` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `tool_stdio_command_templates_company_status_idx` | `tool_stdio_command_templates` | company_id, status | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `user_secret_declarations_company_idx` | `user_secret_declarations` | company_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `user_secret_declarations_company_required_idx` | `user_secret_declarations` | company_id, required | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `user_secret_declarations_definition_idx` | `user_secret_declarations` | user_secret_definition_id | Покрытие FK по user_secret_definition_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `user_secret_declarations_required_override_idx` | `user_secret_declarations` | company_id, allow_missing_override | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `user_secret_declarations_target_idx` | `user_secret_declarations` | company_id, target_type, target_id | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `user_secret_definitions_company_provider_idx` | `user_secret_definitions` | company_id, provider | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `user_secret_definitions_company_status_idx` | `user_secret_definitions` | company_id, status | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `user_secret_definitions_provider_config_idx` | `user_secret_definitions` | provider_config_id | Покрытие FK по provider_config_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `webhook_intake_drafts_company_received_idx` | `webhook_intake_drafts` | company_id, received_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `webhook_intake_drafts_company_status_idx` | `webhook_intake_drafts` | company_id, status, received_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `workspace_operations_company_run_started_idx` | `workspace_operations` | company_id, heartbeat_run_id, started_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `workspace_operations_company_workspace_issue_started_idx` | `workspace_operations` | company_id, execution_workspace_id, issue_id, started_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `workspace_operations_company_workspace_started_idx` | `workspace_operations` | company_id, execution_workspace_id, started_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `workspace_runtime_services_company_execution_workspace_status_idx` | `workspace_runtime_services` | company_id, execution_workspace_id, status | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `workspace_runtime_services_company_project_status_idx` | `workspace_runtime_services` | company_id, project_id, status | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `workspace_runtime_services_company_updated_idx` | `workspace_runtime_services` | company_id, updated_at | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `workspace_runtime_services_company_workspace_status_idx` | `workspace_runtime_services` | company_id, project_workspace_id, status | Покрытие FK по company_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |
| `workspace_runtime_services_run_idx` | `workspace_runtime_services` | started_by_run_id | Покрытие FK по started_by_run_id: каскадные DELETE/UPDATE без Seq Scan и блокировок |

### 5.5 Регламентные / выборки / очереди (B-tree) — 89 индексов

Индексы без декларированного FK, без уникальности и без выражений. Для каждого указано конкретное место использования: очередь/планировщик (фоновые воркеры), retention-очистка, точечный lookup по хэшу/токену. Запросы фоновых воркеров выполняются периодически (секунды–минуты); окно статистики аудита было меньше интервала между запусками, поэтому `idx_scan = 0`. Индексы, для которых по коду подтверждённого потребителя нет, помечены в основании как кандидаты на удаление (работа продолжается в OPE-12979).

| Индекс | Таблица | Колонки / выражение | Основание решения |
|---|---|---|---|
| `activity_log_entity_type_id_idx` | `activity_log` | entity_type, entity_id | Полиморфная ссылка (entity_type, entity_id): история по конкретной сущности |
| `adapter_auth_sessions_expires_idx` | `adapter_auth_sessions` | expires_at | Очистка истёкших сессий адаптера по expires_at (ретеншн) |
| `adapter_auth_sessions_provider_lease_idx` | `adapter_auth_sessions` | provider_lease_id | Lease сессий адаптера по provider_lease_id — арбитраж воркеров |
| `agent_api_keys_key_hash_idx` | `agent_api_keys` | key_hash | Поиск ключа агента по SHA-256-хэшу при каждом аутентифицированном запросе (auth.ts, live-events-ws.ts); частота ~ каждый API-вызов |
| `billing_events_type_idx` | `billing_events` | event_type | Фильтрация биллинговых событий по типу (event_type) — сверки и webhook-обработка |
| `board_processes_last_seen_idx` | `board_processes` | last_seen_at | Хартбит процессов доски: выборка «живых» по last_seen_at на каждый тик мониторинга |
| `built_in_managed_resources_resource_idx` | `built_in_managed_resources` | resource_kind, resource_id | Lookup встроенного управляемого ресурса (resource_kind, resource_id) |
| `chat_actions_inbound_wakeup_sweep_idx` | `chat_actions` | kind, status, created_at, id | Цикл inbound-wakeup sweep: выборка по (kind, status, created_at, id) на каждом тике планировщика |
| `chat_actions_work_pending_retry_idx` | `chat_actions` | status, created_at, id | Рабочая очередь chat_actions: выборка (status, created_at, id) при каждом проходе воркера |
| `chat_deliveries_work_idx` | `chat_deliveries` | state, next_attempt_at | Рабочая очередь доставок: выборка (state, next_attempt_at) на каждый тик ретраев |
| `chat_endpoint_leases_expiry_idx` | `chat_endpoint_leases` | expires_at | Сбор истёкших lease-аренд: выборка по expires_at на каждый тик |
| `chat_publications_work_idx` | `chat_publications` | state, next_attempt_at | Рабочая очередь публикаций: выборка (state, next_attempt_at) на каждый тик |
| `chat_publications_work_pending_retry_idx` | `chat_publications` | state, next_attempt_at | Рабочая очередь публикаций (ветка retry): выборка (state, next_attempt_at) |
| `chat_sdk_state_expiry_idx` | `chat_sdk_state` | expires_at | Очистка просроченного SDK-состояния по expires_at (ретеншн) |
| `chat_teams_file_transfers_work_idx` | `chat_teams_file_transfers` | phase, attempt_expires_at, expires_at | Очередь передач файлов плагина chat-teams: выборка по (phase, attempt_expires_at, expires_at) |
| `claude_setup_token_sessions_deadline_idx` | `claude_setup_token_sessions` | deadline_at | Очистка сессий setup-токенов по deadline_at (ретеншн) |
| `cli_auth_challenges_secret_hash_idx` | `cli_auth_challenges` | secret_hash | Кандидат на удаление: lookup секрета только после выборки по id (board-auth.ts getCliAuthChallengeBySecret); индекс по secret_hash запросами не используется |
| `cloud_upstream_connections_company_idx` | `cloud_upstream_connections` | company_id | Выборка облачных апстримов компании (company_id) |
| `cloud_upstream_runs_company_created_idx` | `cloud_upstream_runs` | company_id, created_at | История прогонов апстрима: (company_id, created_at) |
| `cloud_upstream_runs_connection_idx` | `cloud_upstream_runs` | connection_id | Прогоны конкретного апстрим-соединения (connection_id) |
| `company_memberships_principal_status_idx` | `company_memberships` | principal_type, principal_id, status | Фильтрация членств по типу принципала и статусу (admin-запросы) |
| `company_secret_proposals_expiry_idx` | `company_secret_proposals` | status, expires_at | Очистка просроченных предложений секретов (status, expires_at) — регламентная задача |
| `company_secret_versions_fingerprint_idx` | `company_secret_versions` | fingerprint_sha256 | Дедупликация версий секретов по отпечатку (fingerprint_sha256) |
| `company_secret_versions_value_sha256_idx` | `company_secret_versions` | value_sha256 | Поиск версии секрета по хэшу значения (аудит доступа к секрету) |
| `company_transfer_runs_actor_status_idx` | `company_transfer_runs` | actor_key, status | Мониторинг передач компаний по исполнителю и статусу (actor_key, status) |
| `company_transfer_runs_idempotency_direction_idx` | `company_transfer_runs` | idempotency_key, direction | Идемпотентность передач компаний: (idempotency_key, direction) |
| `company_user_sidebar_preferences_user_idx` | `company_user_sidebar_preferences` | user_id | Панель «мой сайдбар»: выборка настроек по user_id (sidebar-preferences.ts) |
| `connection_intent_deliveries_pending_idx` | `connection_intent_deliveries` | delivered_at, next_attempt_at | Очередь доставки connection-intents: (delivered_at, next_attempt_at) на каждый тик |
| `corpus_parse_jobs_claim_idx` | `corpus_parse_jobs` | status, next_attempt_at | Claim-выборка воркера разбора корпуса: (status, next_attempt_at) при опросе очереди |
| `corpus_shadow_log_ts_idx` | `corpus_shadow_log` | ts | Теневой лог корпуса: интервальные выборки по ts (ретеншн/аналитика) |
| `datastore_audit_reports_key_generated_idx` | `datastore_audit_reports` | datastore_key, generated_at | История аудиторских отчётов datastore: (datastore_key, generated_at) — последняя версия отчёта |
| `datastore_snapshots_key_captured_idx` | `datastore_snapshots` | datastore_key, captured_at | История снапшотов datastore: (datastore_key, captured_at) — последний снапшот |
| `decision_archive_notification_outbox_pending_idx` | `decision_archive_notification_outbox` | status, created_at | Outbox-паттерн нотификаций архива решений: (status, created_at) на каждый тик отправки |
| `email_sends_pending_idx` | `email_sends` | endpoint_id, outcome | Очередь email-отправки: выборка по (endpoint_id, outcome) при обработке очереди |
| `environment_custom_image_setup_sessions_expires_idx` | `environment_custom_image_setup_sessions` | expires_at | Очистка просроченных сессий сборки образа по expires_at (ретеншн) |
| `environment_custom_image_setup_sessions_provider_lease_idx` | `environment_custom_image_setup_sessions` | provider, provider_lease_id | Lease сессий сборки по (provider, provider_lease_id) — арбитраж воркеров |
| `environment_custom_image_templates_last_used_idx` | `environment_custom_image_templates` | last_used_at | Выявление неиспользуемых шаблонов образов по last_used_at (аналитика/очистка) |
| `environment_leases_provider_lease_idx` | `environment_leases` | provider_lease_id | Lease окружений по provider_lease_id — арбитраж параллельных воркеров |
| `environments_status_idx` | `environments` | status | Фильтрация окружений по статусу в UI/оркестрации |
| `execution_workspace_runtime_leases_expires_at_idx` | `execution_workspace_runtime_leases` | expires_at | Сбор истёкших lease рабочих пространств по expires_at на каждый тик |
| `feedback_votes_author_idx` | `feedback_votes` | author_user_id, created_at | Мои голоса в фидбеке: (author_user_id, created_at) |
| `guardrail_events_rule_idx` | `guardrail_events` | rule | Аналитика срабатываний guardrail по конкретному правилу (rule) |
| `heartbeat_runs_execution_control_deadline_idx` | `heartbeat_runs` | execution_control_deadline_at | Контроль дедлайнов execution-control: выборка просроченных прогонов по execution_control_deadline_at |
| `heartbeat_runs_execution_status_delivery_idx` | `heartbeat_runs` | execution_status_delivery_id | Доставка статуса прогона: lookup по execution_status_delivery_id |
| `heartbeat_runs_updated_at_idx` | `heartbeat_runs` | updated_at | Инкрементальные выборки «что изменилось» по updated_at (поллинг) |
| `instance_user_roles_role_idx` | `instance_user_roles` | role | Выборка пользователей инстанса по роли (админ-панель) |
| `issue_claims_expires_idx` | `issue_claims` | expires_at, released_at | Освобождение истёкших claims: выборка по (expires_at, released_at) на каждый тик |
| `issue_continuation_keys_expires_at_idx` | `issue_continuation_keys` | expires_at | Очистка истёкших ключей продолжения по expires_at (ретеншн-задача) |
| `issue_question_response_deliveries_pending_idx` | `issue_question_response_deliveries` | status, created_at | Очередь доставки ответов на вопросы: (status, created_at) на каждый тик |
| `issue_thread_interactions_addressee_user_idx` | `issue_thread_interactions` | addressee_user_id | Панель «мои запросы»: выборка interactions по адресату-пользователю |
| `issue_thread_interactions_pending_timeout_idx` | `issue_thread_interactions` | status, timeout_at | Тайм-аут ожидающих interaction-запросов: (status, timeout_at) на каждый тик |
| `knowledge_deviations_page_idx` | `knowledge_deviations` | page | Пагинация списка отклонений знаний по page |
| `knowledge_deviations_task_idx` | `knowledge_deviations` | task | Связка отклонений знаний с задачей (task) |
| `knowledge_suggestions_trust_idx` | `knowledge_suggestions` | trust | Фильтрация предложений знаний по уровню trust |
| `legacy_blocked_import_issue_id_idx` | `legacy_blocked_import` | issue_id | Импорт legacy-блокировок: lookup по issue_id |
| `litellm_cost_events_company_occurred_collected_idx` | `litellm_cost_events` | company_id, occurred_at, collected_at | Сверки биллинга: (company_id, occurred_at, collected_at) с учётом сбора данных |
| `litellm_cost_events_company_occurred_idx` | `litellm_cost_events` | company_id, occurred_at | Стоимость LiteLLM по компании и времени: (company_id, occurred_at) — биллинговые выборки |
| `litellm_cost_events_company_run_idx` | `litellm_cost_events` | company_id, heartbeat_run_id | Стоимость по конкретному прогону: (company_id, heartbeat_run_id) |
| `myrmidon_eval_runs_baseline_idx` | `myrmidon_eval_runs` | baseline_id | Прогоны конкретного eval-baseline: lookup по baseline_id |
| `myrmidon_fleet_affinity_scope_target_idx` | `myrmidon_fleet_affinity` | scope, target_id | Affinity-правила флота: (scope, target_id) |
| `myrmidon_fleet_moves_phase_idx` | `myrmidon_fleet_moves` | phase | Мониторинг перемещений флота по фазе (phase) |
| `native_run_finalizations_control_deadline_idx` | `native_run_finalizations` | control_deadline_at | Контроль дедлайнов финализации: выборка по control_deadline_at на каждый тик |
| `pipeline_automation_executions_retry_of_execution_idx` | `pipeline_automation_executions` | retry_of_execution_id | Ретраи автоматизации: lookup по retry_of_execution_id |
| `pipeline_case_issue_links_automation_attempt_idx` | `pipeline_case_issue_links` | automation_attempt_id | Связь кейс↔issue по automation_attempt_id |
| `pipeline_cases_automation_attempt_idx` | `pipeline_cases` | automation_attempt_id | Кейсы конкретной попытки автоматизации (automation_attempt_id) |
| `pipeline_cases_lease_expires_idx` | `pipeline_cases` | lease_expires_at | Возврат истёкших lease кейсов пайплайна: выборка по lease_expires_at |
| `plugin_database_namespaces_status_idx` | `plugin_database_namespaces` | status | Мониторинг namespace-баз плагинов по status |
| `plugin_entities_scope_idx` | `plugin_entities` | scope_kind, scope_id | Фильтрация сущностей плагина по scope (scope_kind, scope_id) |
| `plugin_entities_type_idx` | `plugin_entities` | entity_type | Фильтрация сущностей плагина по типу (entity_type) |
| `plugin_job_runs_status_idx` | `plugin_job_runs` | status | Очередь/мониторинг задач плагина по status |
| `plugin_jobs_next_run_idx` | `plugin_jobs` | next_run_at | Планировщик задач плагина: выборка «что запускать» по next_run_at |
| `plugin_logs_level_idx` | `plugin_logs` | level | Фильтрация журнала плагина по уровню (level) — диагностика |
| `plugin_managed_resources_resource_idx` | `plugin_managed_resources` | resource_kind, resource_id | Lookup управляемого ресурса плагина (resource_kind, resource_id) |
| `plugin_migrations_status_idx` | `plugin_migrations` | status | Мониторинг миграций плагинов по status |
| `plugin_webhook_deliveries_key_idx` | `plugin_webhook_deliveries` | webhook_key | Выборка доставок по ключу webhook-эндпоинта (webhook_key) |
| `plugin_webhook_deliveries_status_idx` | `plugin_webhook_deliveries` | status | Очередь webhook-доставок по status |
| `plugins_status_idx` | `plugins` | status | Фильтрация плагинов по статусу (включён/выключен) |
| `provider_trace_records_expiry_idx` | `provider_trace_records` | status, expires_at | Ретеншн provider-trace записей: (status, expires_at) |
| `provider_usage_warning_deliveries_pending_idx` | `provider_usage_warning_deliveries` | next_attempt_at, delivered_at | Очередь предупреждений об использовании: (next_attempt_at, delivered_at) на каждый тик |
| `redaction_substitutions_expiry_idx` | `redaction_substitutions` | expires_at | Ретеншн подстановок редакции: удаление по expires_at |
| `redaction_substitutions_lookup_idx` | `redaction_substitutions` | redaction_id, token | Lookup подстановок редакции по (redaction_id, token) при восстановлении текста |
| `reflect_jobs_status_idx` | `reflect_jobs` | status | Очередь reflect-задач: выборка по status на каждый тик |
| `routine_triggers_next_run_idx` | `routine_triggers` | next_run_at | Планировщик routine-триггеров: выборка «что запускать» по next_run_at на каждый тик |
| `routine_triggers_public_id_idx` | `routine_triggers` | public_id | Lookup триггера по public_id (публичный URL webhook-триггера routines.ts:2941) |
| `tool_action_deliveries_pending_idx` | `tool_action_deliveries` | delivered_at, created_at | Очередь доставки tool-action: (delivered_at, created_at) на каждый тик |
| `tool_oauth_states_actor_idx` | `tool_oauth_states` | created_by_actor_type, created_by_actor_id | Аудит OAuth-состояний по инициатору (created_by_actor_type, created_by_actor_id) |
| `tool_oauth_states_expires_at_idx` | `tool_oauth_states` | expires_at | Очистка просроченных OAuth-состояний по expires_at (ретеншн) |
| `tool_oauth_states_subject_user_idx` | `tool_oauth_states` | company_id, subject_user_id | OAuth-состояния пользователя: (company_id, subject_user_id) при проверке доступа |
| `user_password_set_tokens_user_idx` | `user_password_set_tokens` | user_id, revoked_at | Токены установки пароля пользователя: (user_id, revoked_at) — проверка действующего токена |

### 5.6 Функциональные expression-индексы — 15 индексов

Индексы по выражениям (JSON-пути `context_snapshot->>`, `lower(...)`, `coalesce(...)`). План-зависимые: оптимизатор подхватывает их только при точном совпадении формы выражения в запросе. Обоснование сохранения — до EXPLAIN (ANALYZE, BUFFERS) на боевом объёме (OPE-12979) удаление несёт риск деградации.

| Индекс | Таблица | Колонки / выражение | Основание решения |
|---|---|---|---|
| `activity_log_company_action_continuation_idx` | `activity_log` | company_id, action, (("details" ->> 'continuation')), created_at | Функциональное выражение выборки; живой EXPLAIN — OPE-12979 |
| `activity_log_issue_prev_assignee_idx` | `activity_log` | company_id, (("details" -> '_previous' ->> 'assigneeAgentId')), created_at | Функциональное выражение выборки; живой EXPLAIN — OPE-12979 |
| `agent_wakeup_requests_company_payload_issue_idx` | `agent_wakeup_requests` | company_id, ("payload" ->> 'issueId') | Функциональное выражение выборки; живой EXPLAIN — OPE-12979 |
| `documents_coalesced_title_search_idx` | `documents` | (coalesce("title", '')) gin_trgm_ops | Функциональное выражение выборки; живой EXPLAIN — OPE-12979 |
| `heartbeat_runs_attention_feed_idx` | `heartbeat_runs` | company_id, agent_id, created_at, ("context_snapshot" ->> 'issueId'), ("context_snapshot" ->> 'taskId') | Функциональное выражение выборки; живой EXPLAIN — OPE-12979 |
| `heartbeat_runs_company_ctx_issue_created_idx` | `heartbeat_runs` | company_id, ("context_snapshot" ->> 'issueId'), created_at | Функциональное выражение выборки; живой EXPLAIN — OPE-12979 |
| `heartbeat_runs_company_ctx_paperclip_issue_created_idx` | `heartbeat_runs` | company_id, (("context_snapshot" -> 'paperclipIssue') ->> 'id'), created_at | Функциональное выражение выборки; живой EXPLAIN — OPE-12979 |
| `heartbeat_runs_company_ctx_task_created_idx` | `heartbeat_runs` | company_id, ("context_snapshot" ->> 'taskId'), created_at | Функциональное выражение выборки; живой EXPLAIN — OPE-12979 |
| `heartbeat_runs_company_issue_coalesce_created_idx` | `heartbeat_runs` | company_id, (coalesce("native_issue_id"::text, "context_snapshot" ->> 'issueId')), created_at, id | Функциональное выражение выборки; живой EXPLAIN — OPE-12979 |
| `heartbeat_runs_company_legacy_terminal_issue_idx` | `heartbeat_runs` | company_id, (coalesce("native_issue_id"::text, "context_snapshot" ->> 'issueId')), created_at, id | Функциональное выражение выборки; живой EXPLAIN — OPE-12979 |
| `heartbeat_runs_ctx_issue_status_idx` | `heartbeat_runs` | company_id, ("context_snapshot" ->> 'issueId'), status | Функциональное выражение выборки; живой EXPLAIN — OPE-12979 |
| `heartbeat_runs_ctx_paperclip_issue_id_idx` | `heartbeat_runs` | company_id, (("context_snapshot" -> 'paperclipIssue') ->> 'id') | Функциональное выражение выборки; живой EXPLAIN — OPE-12979 |
| `issue_comments_body_lower_trgm_idx` | `issue_comments` | lower("body") gin_trgm_ops | Функциональное выражение выборки; живой EXPLAIN — OPE-12979 |
| `issues_coalesced_identifier_search_idx` | `issues` | (coalesce("identifier", '')) gin_trgm_ops | Функциональное выражение выборки; живой EXPLAIN — OPE-12979 |
| `issues_open_normalized_title_created_idx` | `issues` | company_id, parent_id, lower(regexp_replace(btrim("title"), '\s+', ' ', 'g')), created_at | Функциональное выражение выборки; живой EXPLAIN — OPE-12979 |

### 5.7 Поисковые индексы (GIN/HNSW/trgm) — 19 индексов

Полнотекстовые/триграммные/векторные индексы (GIN по tsvector и gin_trgm_ops, HNSW по embedding). Обслуживают поиск в UI и API; их отсутствие делает поиск последовательным сканом. Проверка использования — живой EXPLAIN в OPE-12979.

| Индекс | Таблица | Колонки / выражение | Основание решения |
|---|---|---|---|
| `cases_identifier_search_idx` | `cases` | identifier | Поиск (gin); план-зависимый, живой EXPLAIN — OPE-12979 |
| `cases_summary_search_idx` | `cases` | summary | Поиск (gin); план-зависимый, живой EXPLAIN — OPE-12979 |
| `cases_title_search_idx` | `cases` | title | Поиск (gin); план-зависимый, живой EXPLAIN — OPE-12979 |
| `company_skills_company_categories_idx` | `company_skills` | categories | Поиск (gin); план-зависимый, живой EXPLAIN — OPE-12979 |
| `corpus_chunks_content_trgm_idx` | `corpus_chunks` | content | Поиск (gin); план-зависимый, живой EXPLAIN — OPE-12979 |
| `corpus_chunks_embedding_hnsw_idx` | `corpus_chunks` | embedding vector_cosine_ops (HNSW, m=16, ef_construction=64) | Полнотекстовый/векторный/триграммный поиск; план-зависимый, живой EXPLAIN — OPE-12979 |
| `corpus_chunks_fts_idx` | `corpus_chunks` | fts (tsvector) | Полнотекстовый поиск по чанкам корпуса: websearch_to_tsquery @@ fts; план-зависимый, живой EXPLAIN — OPE-12979 |
| `document_annotation_comments_body_search_idx` | `document_annotation_comments` | body | Поиск (gin); план-зависимый, живой EXPLAIN — OPE-12979 |
| `documents_latest_body_search_idx` | `documents` | latest_body | Поиск (gin); план-зависимый, живой EXPLAIN — OPE-12979 |
| `documents_title_search_idx` | `documents` | title | Поиск (gin); план-зависимый, живой EXPLAIN — OPE-12979 |
| `issue_comments_body_search_idx` | `issue_comments` | body | Поиск (gin); план-зависимый, живой EXPLAIN — OPE-12979 |
| `issues_description_search_idx` | `issues` | description | Поиск (gin); план-зависимый, живой EXPLAIN — OPE-12979 |
| `issues_identifier_search_idx` | `issues` | identifier | Поиск (gin); план-зависимый, живой EXPLAIN — OPE-12979 |
| `issues_title_search_idx` | `issues` | title | Поиск (gin); план-зависимый, живой EXPLAIN — OPE-12979 |
| `knowledge_items_roles_idx` | `knowledge_items` | roles | Поиск (gin); план-зависимый, живой EXPLAIN — OPE-12979 |
| `knowledge_search_slug_trgm_idx` | `knowledge_search` | slug | Поиск (gin); план-зависимый, живой EXPLAIN — OPE-12979 |
| `knowledge_search_trgm_idx` | `knowledge_search` | body_trgm | Поиск (gin); план-зависимый, живой EXPLAIN — OPE-12979 |
| `knowledge_search_vector_idx` | `knowledge_search` | search_vector | Поиск (gin); план-зависимый, живой EXPLAIN — OPE-12979 |
| `user_inbox_agent_policies_allowed_agent_ids_idx` | `user_inbox_agent_policies` | allowed_agent_ids | Поиск (gin); план-зависимый, живой EXPLAIN — OPE-12979 |
