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

Migration numbers are unique; the repository's historical gaps are recorded in the baseline and
remain grandfathered. Every number not recorded as a historical gap must be present, including
newly added numbers. The gate checks SQL files, the migration journal, duplicates, removed baseline
numbers, and any newly introduced gap. The package helper `check:migrations` is not the source of
this invariant: it checks numbering format and duplicates but does not enforce gaplessness.

## Enforcement

INV-13, checked by `scripts/myrmidon/ci/arch-invariants-gate.mjs` (`checkMigrations`): SQL files,
the Drizzle journal, unique numbering, baseline preservation, and newly introduced gaps are checked.
The historical baseline is `scripts/myrmidon/ci/arch-invariants-migration-baseline.json`; the
gate does not delegate gap checking to the package helper.

## Alternatives considered

- Timestamp-based migration names: rejected — the repo convention is sequential numbers;
  renaming all migrations at once is a bigger change than the invariant is worth.

## Consequences

- A new PR that introduces a duplicate or a gap fails CI instead of colliding at merge.
- Removing a migration now also requires re-numbering or a baseline update, which is the
  point: deletions become visible.
