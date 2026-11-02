---
divergence-section: 1.6.6 — deferred issue execution wake recovery
---

## changelog-en

### Recover stranded deferred issue-execution wakes (OPE-9445)

- Scheduler reconciliation now expires deferred issue-execution wakes older than 30 minutes, records `deferred_issue_execution_expired`, and wakes the agent again with the affected issue context. Execution-wait wakes remain parked until their blocker is released; queue-drain behavior is preserved. A gauge, `myrmidon_deferred_issue_execution_over_30m`, exposes stale wakes for monitoring.

## changelog-ru

### Восстановление зависших отложенных вызовов по задачам (OPE-9445)

- Плановая сверка отменяет отложенные вызовы старше 30 минут с причиной `deferred_issue_execution_expired` и повторно будит агента с контекстом задачи. Вызовы, ожидающие снятия блокировки, остаются отложенными; обработка очереди сохраняется. Метрика `myrmidon_deferred_issue_execution_over_30m` показывает число устаревших вызовов.
