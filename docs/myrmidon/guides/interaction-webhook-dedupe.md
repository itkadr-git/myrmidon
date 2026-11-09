# Interaction webhook and event deduplication

> Russian version: [interaction-webhook-dedupe.ru.md](interaction-webhook-dedupe.ru.md)

When incoming webhook deliveries, chat bridges, or runtime session runners deliver requests to create task-thread interaction cards, duplicate delivery of the same source event must not create duplicate cards.

The system ensures idempotency by computing a deterministic interaction deduplication key from the event identity and enforcing uniqueness at the database level.

## Deduplication key derivation

For events that do not supply an explicit caller-defined `idempotencyKey`, the router computes a deterministic key via `buildInteractionDedupeKey`:

```typescript
import { buildInteractionDedupeKey } from "../interaction-router/dedupe-key.js";

const dedupeKey = buildInteractionDedupeKey({
  source: "runner",
  sourceEventId: event.sourceEventId,
  issueId: binding.issueId,
  routeType: "human_input",
});
```

The derived key format is `interaction-route:<sha256>`, where the digest hashes the JSON-serialized array `[source, sourceEventId, issueId, routeType]`.

## Precedence and replay behavior

1. **Explicit caller key precedence**: If an explicit non-empty `idempotencyKey` is provided by the caller or request envelope, that explicit key is preserved and takes precedence.
2. **Replay suppression**: Replay of an event with the same source identity and `sourceEventId` targets the existing interaction. The create operation returns the existing card without inserting duplicate database records.
3. **Distinct events**: Events with different `sourceEventId` values generate distinct keys and distinct interaction cards.
