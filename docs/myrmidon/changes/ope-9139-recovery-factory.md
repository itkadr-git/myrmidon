## changelog-en

### Transactional recovery issue factory (OPE-9139)

- Add ensureRecoveryIssue to the recovery action service: concurrent active dedupe keys share one recovery issue, action and blocker edge, with owner/SLA and wake policy persisted atomically.
- Emit committed created/deduped outcomes through the injected metrics port; reject incomplete requests before writes.
- Handle both active dedupe-key and fingerprint uniqueness conflicts atomically, including legacy actions with no dedupe key; repeated concurrent requests reuse the committed recovery without PostgreSQL 23505.
- Add PostgreSQL coverage for concurrency, rollback and owner variants; CI fails rather than skipping when PostgreSQL is unavailable. Registration and owner resolution remain separate integrations.

## changelog-ru

### Транзакционное создание recovery-задач (OPE-9139)

- ensureRecoveryIssue атомарно сохраняет recovery-задачу, действие и связь блокировки; параллельные запросы с одним активным dedupe key не создают дубли.
- Владелец, SLA и wake-политика сохраняются вместе; метрики created/deduped вызываются после коммита, неполные запросы отклоняются.
- Конфликты обоих активных unique index (dedupe key и fingerprint) атомарно возвращают существующую recovery, в том числе для legacy action без dedupe key; конкурентные повторы не приводят к PostgreSQL 23505.
- PG-тесты покрывают конкуренцию, откат транзакции и варианты владельца; отсутствие PostgreSQL в CI считается ошибкой, а не skip. Регистрация и резолвер владельца остаются отдельной интеграцией.
