# ADR-0053 — Effect-worker test discipline (no sleeping waits)

Date: 2026-11-12
Issue: OPE-12798

## Context

The effect-worker layer (OPE-12798) runs effects post-commit on the
transactional outbox transport (`agent_wakeup_requests`). Tests that exercise
this layer need to wait for effects to settle. Sleeping waits (`setTimeout`,
`setInterval`, `sleep`) make CI flaky, slow, and hide race conditions. The
t3code discipline (AGENTS.md G, "drain the worker / wait for a concrete
event, not sleep") must be enforced in this repository.

## Decision

Test files under `server/src/myrmidon/effect-worker/` must not contain
`setTimeout`, `setInterval`, `setImmediate`, or `sleep` calls. Waiting is done
exclusively through the helpers in `test-helpers.ts`:

- `drainEffects(worker)` — runs one drain pass
- `drainEffectsUntilIdle(worker, opts)` — drains until no more work
- `waitForEffectMilestone(db, key, predicate)` — polls persisted intent state
  synchronously (no timer); the predicate runs against the stored
  `payload.effect` milestone

The discipline is enforced by INV-15 in
`scripts/myrmidon/ci/arch-invariants-gate.mjs`.

## Status

Accepted.

## Consequences

- Effect-worker tests are deterministic: the worker and the test share the
  process, so a drain always completes synchronously with respect to the test.
- The gate fails on any new sleep pattern in effect-worker test files.
- Test authors must add new waiting primitives to `test-helpers.ts` (where
  `setImmediate` is allowed for scheduler yields), not inline in tests.
