## changelog-en

### Production capacity dashboard metrics producer (OPE-9565)

- Implements the authoritative production producer for the five capacity metrics specified in OPE-9564:
  - `myrmidon_readiness_ratio` (gauge: ready issues / open issues; 0 when open is 0; unavailable if eligibility cannot be resolved)
  - `myrmidon_queue_age_seconds` (gauge: max elapsed seconds since continuous eligibility `readySince`; 0 when ready queue is empty; unavailable if `readySince` is missing)
  - `myrmidon_project_share{project="..."}` (gauge: share of active claim/run slots per project; 0 when total active slots is 0; sum is 1.0 when active slots > 0; unassigned issues labeled `"unassigned"`)
  - `myrmidon_starvation_total` (counter: ready episodes continuously unclaimed for >= `policy.starvation.afterMin`; exactly one increment per episode crossing threshold; re-scrapes do not increment)
  - `myrmidon_claim_rejection_total{reason="..."}` (counter: authoritative final claim rejection events with bounded closed vocabulary; attemptId deduplication prevents double-counting on HTTP replay)
- Injects the production producer by default into `GET /metrics` (`myrmidonMetricsApp` / `myrmidonMetricsRoutes`) while retaining test injection seams.
- Missing sources and unreachable eligibility are represented as unavailable (`null`), suppressing exposition without emitting fake zeroes.
- OPE-9204 (canary / production dashboard readiness) requires this production producer as an explicit prerequisite.

#### Rollout and Production Readiness
- Rolled out as part of Myrmidon 1.6.6 with no schema migrations required.
- The producer reads from existing tables (`companies`, `issues`, `agents`, `issueClaims`, `heartbeatRuns`, `instanceSettings`).
- Single company-scoped snapshot per scrape; multi-tenant instances evaluate company-scoped context cleanly.
- OPE-9204 can now proceed with production dashboard integration and canary verification against live `/metrics` scrapes.

#### Reset and Unavailable Semantics
- `starvation_total` and `claim_rejection_total` are monotonically increasing process-local counters accumulated since producer start.
- Counters reset only upon process restart or explicit reset. Use Prometheus `rate()` or `increase()` for rate calculations over time windows.
- When `policy.enabled = false`, no new starvation events are registered.
- When an underlying data source or eligibility check is unavailable, the corresponding metrics evaluate to `null` and samples are omitted from exposition; fake zeroes are strictly prohibited.

## changelog-ru

### Production producer метрик capacity dashboard (OPE-9565)

- Реализован authoritative production producer пяти метрик capacity по спецификации OPE-9564:
  - `myrmidon_readiness_ratio` (gauge: ready / open; 0 при open=0; unavailable при невозможности определить eligibility)
  - `myrmidon_queue_age_seconds` (gauge: max(0, snapshotTime - readySince) по ready задачам; 0 при пустой ready очереди; unavailable при отсутствии `readySince`)
  - `myrmidon_project_share{project="..."}` (gauge: доля активных слотов claim/run по проектам; 0 при отсутствии активных слотов; сумма долей равна 1 при active > 0; задачи без проекта помечаются `"unassigned"`)
  - `myrmidon_starvation_total` (counter: число ready-эпизодов, непрерывно находящихся в очереди >= `policy.starvation.afterMin`; один инкремент на эпизод при пересечении порога; повторные скрейпы не увеличивают счётчик)
  - `myrmidon_claim_rejection_total{reason="..."}` (counter: события окончательного отклонения claim с закрытым словарем из 9 причин; дедупликация по attemptId при повторах)
- Подключен producer по умолчанию в эндпоинт `GET /metrics` (`myrmidonMetricsApp` / `myrmidonMetricsRoutes`) с сохранением seam для тестов.
- Отсутствующие источники данных возвращают `null` и исключаются из экспозиции; фиктивные нули запрещены.
- OPE-9204 (готовность production/canary dashboard) получает данный producer как обязательный prerequisite.

#### Развертывание и Production Readiness
- Поставляется в Myrmidon 1.6.6 без миграций базы данных.
- Использует существующие таблицы (`companies`, `issues`, `agents`, `issueClaims`, `heartbeatRuns`, `instanceSettings`).
- Обрабатывает один company-scoped snapshot за скрейп без смешивания компаний.
- OPE-9204 может переходить к приёмке canary/production dashboard на живом эндпоинте `/metrics`.

#### Семантика Reset и Unavailable
- `starvation_total` и `claim_rejection_total` — накопительные счётчики с момента запуска процесса. Сброс происходит только при перезапуске процесса; в Prometheus используйте `rate()` или `increase()`.
- При `policy.enabled = false` новые события starvation не регистрируются.
- При недоступности БД или eligibility метрики принимают значение `null` и не экспонируются в скрейпе (фиктивные нули исключены).
