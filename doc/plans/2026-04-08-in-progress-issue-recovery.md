# 2026-04-08 In-Progress Issue Recovery Plan

Status: Proposed
Date: 2026-04-08
Audience: Product and engineering
Related:
- `server/src/services/heartbeat.ts`
- `server/src/services/issues.ts`
- `server/src/services/issue-assignment-wakeup.ts`
- `server/src/routes/issues.ts`
- `server/src/__tests__/heartbeat-process-recovery.test.ts`
- `server/src/__tests__/issues-checkout-wakeup.test.ts`
- [PAP-1227](/PAP/issues/PAP-1227)

## 1. Purpose

This note defines how Paperclip should handle an issue that is:

- still `in_progress`
- still assigned
- but no longer has anyone actively working on it

The problem is not just stale UI. It is a control-plane gap: the issue still looks owned, but no future wake is guaranteed, so work can stop indefinitely.

## 2. Current Behavior

Paperclip already has several partial protections:

- checkout adoption when a stale `checkoutRunId` points at a terminal or missing run in `server/src/services/issues.ts`
- execution lock cleanup when `executionRunId` points at a non-active run in both `issues.ts` and `heartbeat.ts`
- orphaned local process recovery in `heartbeat.reapOrphanedRuns()`
- deferred wake promotion in `releaseIssueExecutionAndPromote()`
- one follow-up retry when a run ends without posting an issue comment

What is still missing is a continuity rule for the issue itself.

When a heartbeat run finishes and the issue remains `in_progress`, Paperclip currently clears `executionRunId` and may promote an already-deferred wake. If there is no deferred wake, the issue is simply left assigned and `in_progress`.

That means an issue can legitimately end up in this state:

- `status = in_progress`
- `assigneeAgentId != null`
- `executionRunId = null`
- `checkoutRunId` points at an old finished run, or is otherwise stale
- no queued/running wake exists for the issue

At that point, nothing automatically resumes the work.

## 3. Root Cause

The system enforces comment continuity, but not execution continuity.

Today the lifecycle is effectively:

1. wake the assignee
2. run one heartbeat
3. require a comment
4. stop unless some other event happens

That is fine for tasks that move themselves to `done`, `blocked`, or `in_review` in one heartbeat. It fails for work that legitimately spans multiple heartbeats but does not produce a new external trigger.

This is why the issue can "just sit there": there is no invariant saying "`in_progress` must imply an active run, a queued continuation, or an explicit waiting state."

## 4. Desired Invariant

For an assigned issue, `in_progress` should mean one of these is true:

1. there is an active execution run for the issue
2. there is a queued/deferred wake that will resume the issue soon
3. the system has exhausted bounded automatic recovery and has surfaced the issue for explicit human/agent intervention

What must not be allowed as a steady state is:

- assigned
- `in_progress`
- no active run
- no queued continuation
- no visible escalation

## 5. Proposed Plan

## 5.1 Add a first-class orphaned-issue detector

Introduce a shared helper that identifies an "orphaned in-progress issue":

- `status === "in_progress"`
- `assigneeAgentId` is present
- no queued/running run currently owns the issue
- no deferred wake already exists for the issue
- `checkoutRunId` is null, missing, or points at a terminal/missing run

This should live close to the existing issue/run ownership logic so the rules do not diverge.

## 5.2 Queue one automatic continuation wake

When a run finishes, after execution-lock release and deferred-wake promotion, check whether the linked issue is now orphaned.

If it is, queue exactly one automatic continuation wake for the same assignee.

Important constraints:

- do not reassign the issue; V1 explicitly avoids automatic reassignment
- do not reset the issue back to `todo`; it is still owned work
- do not create duplicate queued continuation wakes if one already exists
- keep using the existing stale-checkout adoption path so the next run can legally reclaim the old checkout

Suggested wake reason:

- `issue_continuation_needed`

Suggested payload/context fields:

- `issueId`
- `retryOfRunId`
- `wakeReason = "issue_continuation_needed"`
- `retryReason = "issue_continuation_needed"`

## 5.3 Bound retries and escalate explicitly

The continuation wake must be bounded.

Recommended rule:

- first orphaning event: queue one automatic continuation wake
- if the continuation wake also ends and the issue is still orphaned: stop retrying automatically and surface the problem

Escalation behavior:

- add an issue comment explaining that work is still `in_progress` but no live run remains
- keep the assignee unchanged
- move the issue to `blocked` only if we want strict workflow semantics for "waiting on intervention"

My recommendation is:

- keep the first recovery silent except for activity/run events
- on exhaustion, add a comment and set `status = blocked`

That creates a visible operator queue instead of leaving the issue silently stranded.

## 5.4 Add a background sweep for legacy stranded issues

Run finalization fixes future cases, but it does not repair issues already stranded in existing data.

Add a periodic sweep, alongside other heartbeat housekeeping, that finds issues already matching the orphaned condition and applies the same recovery path.

This sweep should:

- skip issues that already have a queued continuation wake
- skip issues whose assignee is paused/terminated/pending approval
- queue a continuation wake when safe
- otherwise add a visible escalation comment and/or mark `blocked`

This sweep is the backstop for:

- server restarts
- historical bugs
- manual DB inconsistencies
- cases where a run died outside the normal finalization path

## 5.5 Expose the state to operators

Even with auto-recovery, the UI should make the state visible.

Add a derived flag or state in the issue read model, something like:

- `workState = active | queued | orphaned | blocked`

or:

- `needsRecovery = true`

Use that to surface:

- a badge on issue detail and lists when an issue is `in_progress` with no live run
- a dashboard/inbox count for orphaned assigned work

This is important because the current state is easy to miss: the issue looks "in progress" even when nobody is actually executing it.

## 6. Suggested Implementation Order

## 6.1 Phase 1: continuity on run finalization

Implement the smallest high-confidence fix in `server/src/services/heartbeat.ts`:

- after a run reaches terminal state and issue execution is released/promoted, detect whether the issue is orphaned
- queue one continuation wake when needed
- add tests for success, failure, timeout, and cancelled paths where the issue remains `in_progress`

This prevents new stranded issues created by normal run completion.

## 6.2 Phase 2: background sweep

Add a scheduled sweep for existing orphaned issues and for edge cases that bypass normal finalization.

This repairs the current backlog and makes the system robust across restarts.

## 6.3 Phase 3: operator visibility

Expose the derived recovery state in issue APIs and show it in the UI.

This gives humans a direct answer to "what is assigned but not actually being worked right now?"

## 7. Test Plan For The Implementation

The implementation should add focused server tests for:

- a run that ends successfully while the issue remains `in_progress` and assigned queues one continuation wake
- a run that ends with failure/timeout and leaves the issue orphaned also queues one continuation wake
- no continuation wake is queued when a deferred wake already exists
- no duplicate continuation wake is queued when one is already pending
- the second orphaning event after a continuation retry produces escalation instead of another infinite retry
- the background sweep recovers a pre-existing orphaned issue
- paused or terminated assignees are not auto-woken

## 8. Recommendation

The right fix is not automatic reassignment and not silently leaving the issue alone.

The right fix is:

- preserve ownership
- auto-resume once
- escalate visibly if continuity still fails

That matches V1's explicit ownership model while closing the current gap where assigned `in_progress` work can stop forever with no signal.
