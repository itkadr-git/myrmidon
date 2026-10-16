---

divergence-section: Трек 1 — адаптеры и интеграции
---

## changelog-en

### Add fail-closed migration source journal verifier (MIGRATE-A)

- Pin Paperclip migration compatibility to the verified Myrmidon 0279 journal and reject unsupported URL/dump history before target writes.

## changelog-ru

### Добавлена строгая проверка журнала миграций (MIGRATE-A)

- Совместимость ограничена проверенным журналом Myrmidon до 0279; неподдерживаемая история URL/dump отклоняется до записи в цель.

## divergence

| MIGRATE-A | Добавляет CLI preflight для миграции Paperclip с fail-closed проверкой журнала | `cli/src/commands/myrmidon-migrate*.ts` | Не допустить ложное подтверждение совместимости по имени последней миграции | `cli/src/__tests__/myrmidon-migrate.test.ts` | Удалить команду и verifier | #1309 |
