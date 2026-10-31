# Capacity policy canary runbook

## Status

PLANNED / NOT EXECUTED. This document does not authorize a production canary,
a flag change, a deployment, or access to production data. ADM owns release and
production execution. Preparation is not integrated acceptance.

## Prerequisites

Before any canary, record merged revisions and green CI for the following:

- OPE-9201: real capacity metric sources and their production collection wiring.
  PR #1908 defines a provider contract; registration alone does not prove a producer.
- OPE-9170: B11 imports `CAPACITY_POLICY_PANELS` from
  `server/src/myrmidon/monitoring/dashboard/capacity-policy.ts`, calls
  `assertCapacityPolicySourcesRegistered()`, and queries the existing source adapter.
  This is a proposed registration seam, pending the B11 owner's agreement.
  This change does not modify B11 UI or register panels by side effect.
- OPE-9202: implemented project-scoped enablement and runtime rollback.
  Its PG CI must prove disabled behavior is unchanged and switching takes effect
  on the next tick without a restart. Do not infer an API from the shared schema.
- ADM supplies the approved operational threshold source, observation window,
  sample freshness limit, pilot project, control project and release permission.
  OPE-8312's design document currently does not provide a section 5.12 or these
  numeric limits. No numeric operational threshold is approved by this runbook.

B11 must query one company/role/instance scope, not sum replicated snapshots.
Keep `project` and `reason` labels. Do not manufacture project scope for global
readiness, age or starvation families. Null, absent and stale samples mean
unavailable, not zero. A counter value is cumulative since producer start;
compare deltas with reset handling, not raw counter magnitudes.

## Per-project enablement

1. ADM records the approved release revision and the selected project's ID.
   Keep all other projects disabled. Confirm the actual project-scoped K11
   setting path and read-back command from OPE-9202 after it merges.
2. Record disabled baseline and control observations over the approved window.
   Confirm all five panels have fresh real samples and correct source scope.
3. Record threshold values, units, comparison direction and the window from the
   approved source. If any value or control observation is missing, do not enable.
4. Only after separate release authorization, ADM uses the K11 project-scoped
   interface to set enabled=true for the pilot and reads back the effective policy.
   Confirm the next tick uses that policy and leaves control projects unchanged.
5. Observe the same scope and window. Check stop conditions before expansion.
   Expand to another explicitly selected project only after ADM records acceptance.

## Stop thresholds

| Panel / metric | Stop decision |
| --- | --- |
| Readiness / `myrmidon_readiness_ratio` | Stop on regression beyond the approved baseline-relative bound and window. |
| Queue age / `myrmidon_queue_age_seconds` | Stop when the maximum ready-episode age exceeds the approved age limit. |
| Project share / `myrmidon_project_share` | Compare each project with the approved effective fairness policy and demand context. Stop at the approved breach window. |
| Starvation / `myrmidon_starvation_total` | Stop when reset-aware new starved episodes exceed the approved delta limit. |
| Rejections / `myrmidon_claim_rejection_total` | Compare reset-aware deltas by reason with baseline and approved reason-specific limits. |

Threshold values and windows are unresolved release prerequisites, not defaults.
`fairness.perProjectMaxShare` and `starvation.afterMin` are policy inputs, not
approved operational alarm thresholds. Do not turn their schema defaults into SLOs.
Missing/stale samples, source errors, incorrect project scope, loss of claim
invariants or an ineffective disable switch halt expansion and trigger rollback.
Do not wait for a numeric dashboard limit after a safety invariant fails.

## Rollback

1. ADM sets enabled=false for every enabled pilot project through the real K11
   interface. Record the effective policy before and after, project ID and time.
   Do not use a guessed endpoint or a process restart as the rollback mechanism.
2. Read back enabled=false. Verify the next scheduler tick uses legacy ordering.
   Confirm other projects retain their prior settings and claim invariants hold.
3. Keep monitoring over the approved recovery window. Confirm queue behavior and
   rejection deltas recover against baseline. Preserve samples, including resets.
4. If the switch fails or recovery cannot be verified, stop expansion and escalate
   to ADM with the affected scope and evidence. Do not deploy from this runbook.

## Evidence

No canary was executed. Record actual results separately from this procedure:
release SHA/image digest; K10/B11/K11 merged revisions and CI runs; registration
assertion result and real sample timestamps; project IDs; effective settings;
approved threshold source and values; baseline/control/canary windows; per-panel
observations; decision owner; rollback read-back and next-tick evidence.

Structural tests cover the five-panel configuration, the real registry lookup,
missing-source rejection, and this document's sections. Passing preparation tests
while sources are unavailable does not satisfy integrated delivery acceptance.
B11 rendering, actual producer wiring and the K11 switch remain delivery gates.
