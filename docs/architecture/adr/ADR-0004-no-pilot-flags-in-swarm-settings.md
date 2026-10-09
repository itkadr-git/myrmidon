# ADR-0004: No pilot flags in swarm settings

- Status: accepted
- Date: 2026-10-09
- Deciders: repository owner
- Scope: swarm-queue settings, swarm claim code

## Context

A pilot flag lived in swarm settings after the decision to remove pilots had been made: it
was hidden in settings, survived the cleanup, and kept influencing behavior that the recorded
decision said was gone. Retrospective review caught it only at the final audit.

## Decision

Swarm-queue settings and swarm code contain no pilot fields and no `pilot` word. Pilots are
release flags with an ADR, not hidden settings: if something needs a staged rollout, it gets
a release-flag entry and an ADR that states the removal condition, not a quiet key in the
swarm settings schema.

## Enforcement

INV-12, checked by `scripts/myrmidon/ci/arch-invariants-gate.mjs` (`checkNoPilot`): the
swarm settings and swarm-claim code (comments stripped) must not mention `pilot`.

## Alternatives considered

- Rename pilot fields instead of removing them: rejected — renaming hides the divergence from
  the recorded decision instead of fixing it.

## Consequences

- A removed decision cannot survive in code as a settings key.
- Grep-friendliness: `pilot` in swarm code is now a CI failure, so the word can be used as a
  reliable signal in release checklists.
