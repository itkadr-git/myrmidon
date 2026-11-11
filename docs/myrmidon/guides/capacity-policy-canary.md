# Capacity policy canary runbook

## Status

PLANNED / NOT EXECUTED. This document records the approved canary procedure and
the ADM-approved thresholds; it does not by itself authorize a production canary
run, a flag change, a deployment, or access to production data. ADM owns release
and production execution. Preparation is not integrated acceptance.

## Prerequisites

Before any canary, record merged revisions and green CI for the following:

- OPE-9201: capacity metric sources. PR #1908 is merged and all five
  `myrmidon_*` families are registered in `METRIC_FAMILIES` on main. Production
  producer wiring must still be confirmed on the target instance.
- OPE-9170: B11 imports `CAPACITY_POLICY_PANELS` from
  `server/src/myrmidon/monitoring/dashboard/capacity-policy.ts`, calls
  `assertCapacityPolicySourcesRegistered()`, and queries the existing source
  adapter.
- OPE-9202: project-scoped enablement and runtime rollback. Its PG CI must
  prove disabled behavior is unchanged and switching takes effect on the next
  tick without a restart. Take the actual setting path and read-back command
  from its merged documentation.

Threshold values in this runbook are the approved ADM architect decision of
2026-10-31 recorded in the OPE-9204 issue thread. They are fixed inputs; do not
substitute schema defaults or policy inputs for them. ADM still supplies the
release revision, the pilot selection, and separate release permission before
any execution.

B11 must query one company/role/instance scope, not sum replicated snapshots.
Keep `project` and `reason` labels. Null, absent and stale samples mean
unavailable, not zero. Counters are cumulative since producer start; compare
reset-aware deltas, not raw magnitudes.

## Per-project enablement

1. ADM records the approved release revision and the pilot scope: 1 company or
   10% of agents. All other projects/companies stay disabled.
2. Record the disabled baseline over the last 60 minutes before enablement:
   readiness ratio, p95 queue age, per-project share, starvation and
   claim-rejection counter deltas. Confirm all five panels have fresh real
   samples in one company/role/instance scope.
3. Confirm the readiness criteria below hold on the baseline before enabling.
   If any value or control observation is missing, do not enable.
4. Only after separate release authorization, ADM enables the capacity policy
   for the pilot scope through the real K11 interface and reads back the
   effective policy. Confirm the next tick uses it and control projects are
   unchanged. The rollback path (enabled=false / restoring the previous
   settings block) must be verified ready before the switch.
5. Observe 60 minutes at each step. Check readiness and safety conditions
   continuously. Expand only after ADM records acceptance.

Canary exposure and expansion order: 10% → 50% → 100% (a single company may be
the first step). Every step runs 60 minutes with the same thresholds, and the
baseline for every comparison is the last 60 minutes before that step's
enablement.

## Stop thresholds

Readiness — continue only if all of the following hold:

| Metric | Condition |
| --- | --- |
| `myrmidon_readiness_ratio` | ≥ 0.95 on average over 15 minutes, and never < 0.90 for longer than 5 consecutive minutes. |
| `myrmidon_queue_age_seconds` | p95 ≤ 900 s and not above the baseline by more than 25%. |

Safety — roll back immediately on any of the following:

| Metric | Condition |
| --- | --- |
| `myrmidon_starvation_total` | Increased by at least 1 during the canary window (reset-aware delta). |
| `myrmidon_claim_rejection_total` | Growing faster than 2× baseline for 10 consecutive minutes (reset-aware deltas by reason). |
| `myrmidon_project_share` | Any project > 0.6 while other projects have had a queue for more than 15 minutes. |
| `myrmidon_readiness_ratio` | < 0.80 at any moment. |

Missing/stale samples, source errors, incorrect project scope, loss of claim
invariants or an ineffective disable switch also halt expansion and trigger
rollback. Do not wait for a numeric dashboard threshold after a safety
invariant fails.

## Rollback

1. Restore the previous `runPriority` and capacity policy with a single
   instance-settings PATCH carrying the full previous block object, not a
   partial update. Record the effective settings before and after, the scope
   and the time.
2. Verify via `/metrics` after 5 minutes that readiness, queue age, project
   share, starvation and rejection deltas returned to baseline. Confirm claim
   invariants hold and other projects kept their settings.
3. Keep monitoring over the recovery window; preserve samples including
   counter resets.
4. If the switch fails or recovery cannot be verified, stop expansion and
   escalate to ADM with the affected scope and evidence. Do not deploy from
   this runbook.

## Evidence

No canary was executed. Record actual results separately from this procedure:
release SHA/image digest; merged revisions and CI runs; registration assertion
result and real sample timestamps; pilot/control scope IDs; effective settings;
baseline/canary windows; per-panel observations against the numeric thresholds
above; decision owner; rollback read-back and the 5-minute `/metrics`
verification.

Structural tests cover the five-panel configuration, the real registry lookup
(all five families present in `METRIC_FAMILIES`) and this document's sections.
B11 rendering, actual producer wiring and the K11 switch remain delivery gates
executed under ADM release control.
