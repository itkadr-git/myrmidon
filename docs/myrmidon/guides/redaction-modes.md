# Redaction modes

The guardrails API exposes `POST /api/myrmidon/guardrails/redact` and `POST /api/myrmidon/guardrails/restore`.

`redact` accepts `{ text, entities, mode, ttlMs? }`. Entities contain `type`, `value`, `start`, and `end` offsets. Modes are:

- `reversible`: replaces entities with tokens such as `[PERSON_1]`, stores originals in the service database, and returns `redactionId` and `expiresAt`.
- `irreversible`: replaces entities with tokens and does not persist originals.
- `flag`: leaves `text` unchanged and returns the detected entity spans.

`restore` accepts `{ redactionId, text }`. It restores only substitutions that have not expired. A background sweep removes expired rows every minute; the database index on `expires_at` keeps the sweep bounded by the expiry index.
