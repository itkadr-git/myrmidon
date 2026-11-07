## changelog-en

### Atomic review admission (REVIEW-ADMISSION)

Entering `in_review` and changing the assigned reviewer now use the issue-update transaction to persist a durable reviewer wake request. Execution-stage review wake requests are persisted through the same transaction path.

## changelog-ru

### Атомарный допуск к ревью (REVIEW-ADMISSION)

Переход в `in_review` и смена назначенного ревьюера сохраняют запрос на пробуждение в той же транзакции, что и обновление задачи. Запросы пробуждения этапа ревью также сохраняются в этой транзакции.
