---
divergence-section: Трек 2 — ядро побудок и прогонов
---

## changelog-en

### Wake resurrection for rejected wakeups (WAKE-STALL-ROOT A)

- A wakeup rejected by the board with `execution_reconciliation_required`
  is executed once after the execution reconciliation finishes (one bounded
  retry) instead of being lost. Adds `resurrectionCount` to
  `agent_wakeup_requests` (migration 0303); the rerun carries a fresh
  idempotency key and an incremented resurrection counter, at most one retry
  per wakeup, and no retry when `evidence.automaticRecovery.replay="blocked"`.

## changelog-ru

### Воскрешение отбитых побудок (WAKE-STALL-ROOT A)

- Побудка, отбитая доской с причиной `execution_reconciliation_required`,
  после завершения сверки исполнения выполняется сама (один ограниченный
  повтор), а не теряется. В `agent_wakeup_requests` добавлено поле
  `resurrectionCount` (миграция 0303); повтор идёт с новым ключом
  идемпотентности и инкрементированным счётчиком, не более одного повтора на
  побудку, без повтора при `evidence.automaticRecovery.replay="blocked"`.

## divergence

| WAKE-STALL-ROOT A | Побудка агента, отбитая доской с причиной `execution_reconciliation_required`, после завершения сверки исполнения выполняется сама (один ограниченный повтор), а не теряется. Реализация: добавлено поле `resurrectionCount` в таблицу `agent_wakeup_requests`, добавлена логика воскрешения в `server/src/modules/run-dispatch/adapters/postgres.ts` в точку установки статуса `skipped`, которая теперь при установке статуса `skipped` с причиной `execution_reconciliation_required` создает новую запись `agentWakeupRequest` с новым idempotency ключом и инкрементированным счётчиком воскрешений. Ограничения: не более 1 повтора на побудку, исключение для `evidence.automaticRecovery.replay="blocked"`. Документация: EN+RU guides, тесты | `server/src/modules/run-dispatch/adapters/postgres.ts` (логика воскрешения), `packages/db/src/schema/agent_wakeup_requests.ts` (новое поле `resurrectionCount`), `packages/db/src/migrations/0303_add_resurrection_count_to_wakeup_requests.sql` (миграция), `docs/myrmidon/guides/wake-resurrection-service.md`, `docs/myrmidon/guides/wake-resurrection-service.ru.md`, `server/src/myrmidon/resurrection-service.ts`, `server/src/myrmidon/resurrection-service.myrmidon.test.ts` | Побудка агента, отбитая доской с причиной `execution_reconciliation_required`, после завершения сверки исполнения должна выполняться сама (один ограниченный повтор), а не теряться | `server/src/myrmidon/resurrection-service.myrmidon.test.ts` | Никогда, наше поведение | — |
