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
