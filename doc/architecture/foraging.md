---
title: Foraging
summary: Idle-gated source sweeps that turn changes into bounded learning candidates
---

Foraging periodically compares configured external sources and hands meaningful changes to the skill-candidate boundary. It is a learning input, not an automatic policy publisher; approved company guidance still travels through [[wiki]].

## Pass pipeline

For each enabled source, the pass reads through an injected reader, normalizes the response into sorted unique non-empty lines, and compares it with the stored snapshot. The first read establishes a baseline and creates no finding. Later changes produce capped added and removed sets, then a candidate is requested through the candidate port.

The pass is failure-isolated: an unreachable source records its error and the sweep continues. If the candidate port is absent, the finding remains `unverified`; a present port may accept or reject it. No source change bypasses that seam.

## Scheduling and gates

The settings resolver is called on every pass, so instance settings changes apply without a restart. The idle gate checks each source's role independently: the role queue must be empty and at least one role agent must have no todo/in-progress work, live heartbeat, or claim. A busy role is skipped with `queue_not_empty` or `no_idle_agent`; other roles still run.

The pass has a deterministic cost estimate based on fetched bytes. A positive per-pass ceiling stops before the next read once spent cost reaches the ceiling; untouched sources remain for the next pass. Daily and monthly spend limits, finance events, and the baseline cost-per-task auto-off signal are recorded by the limits and finance ports.

## Evidence and operations

The pass journal records reads, findings, errors, and idle-gate skips. A source row keeps its last snapshot and error state. Findings and candidates carry the source id, role, URL, diff summary, and detection time so an operator can trace a learning input back to its origin.

Foraging reads are bounded by `MAX_SOURCE_BYTES`; the default interval is 3600 seconds and the default pass budget is 50 cents. These defaults are domain constants; effective settings are resolved at runtime.

## Source map

- `server/src/myrmidon/foraging/domain.ts` — normalization, diff, budget, and source contracts.
- `server/src/myrmidon/foraging/service.ts` — pass orchestration and failure isolation.
- `server/src/myrmidon/foraging/idle-gate-settings.ts` — live idle-gate settings.
- `server/src/myrmidon/foraging/limits.ts` — spend windows and auto-off signals.
- `server/src/myrmidon/foraging/pass-journal.ts` — pass evidence.
