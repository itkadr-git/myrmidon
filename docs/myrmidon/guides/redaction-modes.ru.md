# Режимы маскирования

API guardrails предоставляет `POST /api/myrmidon/guardrails/redact` и `POST /api/myrmidon/guardrails/restore`.

`redact` принимает `{ text, entities, mode, ttlMs? }`. Каждый элемент entities содержит `type`, `value`, `start` и `end` (смещения в исходном тексте). Режимы:

- `reversible`: заменяет сущности токенами вроде `[PERSON_1]`, хранит оригиналы в БД и возвращает `redactionId` и `expiresAt`.
- `irreversible`: заменяет сущности токенами, но не сохраняет оригиналы.
- `flag`: не меняет `text`, возвращает диапазоны найденных сущностей.

`restore` принимает `{ redactionId, text }` и восстанавливает только ещё не истёкшие подмены. Фоновая задача удаляет просроченные строки раз в минуту.
