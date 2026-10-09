# ADR-0005: Migration numbers are unique and gapless

- Status: accepted
- Date: 2026-10-09
- Deciders: repository owner
- Scope: database migrations (`packages/db/src/migrations/`)

## Context

Migration numbers were duplicated in three separate PRs during one release window: two PRs
shipped migrations with the same number, and a third re-used a number from an already-merged
migration. Duplicate numbers break the ordering assumption of the migration runner and can
silently skip a migration on fresh installs; gaps hide skipped or reverted migrations.

## Decision

Migration numbers start at `0001`, are unique, and consecutive. `check:migrations`
(`packages/db/src/check-migration-numbering.ts`) already validates the rule; this ADR makes
it a blocking invariant.

## Enforcement

INV-13, checked by `scripts/myrmidon/ci/arch-invariants-gate.mjs` (`checkMigrations`)
via the package's own numbering check. Historic gaps that existed when this ADR was accepted
are recorded in `scripts/myrmidon/ci/arch-invariants-migration-baseline.json` and grandfathered:
no new gaps or duplicates are accepted.

## Alternatives considered

- Timestamp-based migration names: rejected — the repo convention is sequential numbers;
  renaming all migrations at once is a bigger change than the invariant is worth.

## Consequences

- A new PR that introduces a duplicate or a gap fails CI instead of colliding at merge.
- Removing a migration now also requires re-numbering or a baseline update, which is the
  point: deletions become visible.
