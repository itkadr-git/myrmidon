---
divergence-section: Трек 5 — эксплуатация
---

## changelog-en

### Review-wait cancellations no longer create execution holds (CONTINUATION-WAIT-HOLD)

- A legacy continuation cancelled while waiting for reviewer feedback or an
  unresolved response no longer creates `legacy_execution_requires_reconciliation`.
- The task therefore remains eligible for the normal idle-pickup path instead of
  requiring an operator to clear a hold for a provider that never started.

## changelog-ru

### Отмена ожидания ревью больше не ставит удержание выполнения (CONTINUATION-WAIT-HOLD)

- Устаревшее продолжение, отменённое в ожидании отзыва ревьюера или
  неразрешённого ответа, больше не создаёт
  `legacy_execution_requires_reconciliation`.
- Поэтому задача остаётся доступной обычному idle-pickup и не требует ручного
  снятия удержания для провайдера, который не запускался.

## divergence

| CONTINUATION-WAIT-HOLD | `legacyExecutionNeedsReconciliation` возвращает `false` для отменённых legacy-продолжений с кодами `issue_continuation_waiting_on_review` и `issue_waiting_for_response`; отмена queued continuation происходит до запуска провайдера и не свидетельствует о неизвестном внешнем действии | `server/src/services/legacy-execution-recovery.ts` (метка `myrmidon(CONTINUATION-WAIT-HOLD)`), `server/src/services/legacy-execution-recovery.test.ts` | Отмена ожидания ревью до запуска провайдера создавала `legacy_execution_requires_reconciliation`, из-за чего idle-pickup исключал открытую задачу и она оставалась без автоматического исполнителя | `server/src/services/legacy-execution-recovery.test.ts` (оба кода ожидания не создают удержание; обычные ошибки по-прежнему проверяются существующими тестами) | Никогда, наше поведение. Если вендор начнёт классифицировать эти коды как безопасные ожидания до запуска провайдера, удалить ветку с меткой и тесты | (этот PR) |
