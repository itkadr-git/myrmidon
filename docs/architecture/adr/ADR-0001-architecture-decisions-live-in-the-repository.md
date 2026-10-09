# ADR-0001: Architecture decisions live in the repository

- Status: accepted
- Date: 2026-10-09
- Deciders: repository owner
- Scope: whole repository

## Context

Product decisions were previously spread across board documents: target architecture (v2.4,
section 0 "Invariants"), vision, information architecture, and a decisions registry. None of
these lived in the repository. Divergences between decisions and code were caught only by
retrospective human review: a pilot flag survived after the decision to remove it; two different
cooldown rules collided at merge; two competing queue-ordering models met in the same PR; migration
numbers were duplicated across three PRs; documentation referenced code that did not exist.

## Decision

1. The architecture catalog lives in `docs/architecture/`: `README.md` is the invariant index
   (section 0 of the target architecture), `adr/` holds decision records, `invariants/` holds
   fitness-function tests.
2. Every binding product decision gets an ADR (`docs/architecture/adr/ADR-NNNN-<slug>.md`):
   status, date, decision, alternatives, consequences, and pointers to the real modules it
   touches. ADRs may not reference code that does not exist.
3. Invariants that can be checked by code are enforced in CI by
   `scripts/myrmidon/ci/arch-invariants-gate.mjs` (+ its selftest). A violation fails CI before
   human review.
4. The invariant index (`docs/architecture/README.md`) is owner-only: it is changed only with the
   owner's explicit decision, recorded as an ADR that names the invariant being replaced.
5. The PR template asks: "which ADR does this PR implement or change?"

## Consequences

- Decisions are reviewable as diffs, and the reviewer of a PR can see whether it follows or
  changes a recorded decision.
- The invariant gate is a fitness function: the codebase cannot silently drift from the
  recorded architecture.
- Cost: ADRs must be maintained; the decisions registry on the board remains the living source
  for new decisions until they are ported to an ADR.
