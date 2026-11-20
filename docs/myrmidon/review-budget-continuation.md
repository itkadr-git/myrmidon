# Review budget deferral and continuation cooldown

This describes the proposed behavior in PR #4598; it is not deployed until the PR is merged and an operator rolls out its CI-built image.

When a current review participant's decision cannot read CI because the shared review budget is exhausted, the decision remains rejected. An already triggered `Review CI wait` monitor is deferred for 61 minutes and marked as budget-deferred; this is a conservative delay, not a measured reset time. A new PR head releases that particular deferral. Other monitors retain their deadlines. The subsequent decision normally needs fresh CI evidence for the exact head; the bounded return-only exception is described below. This does not change the budget cap or bypass fail-closed admission.

## Review verdict admission (PR #4608)

The following applies after PR #4608 is merged and deployed. APPROVE requires a fresh successful exact-head CI read. REQUEST CHANGES normally reads CI fresh; only when the shared GitHub review budget is exhausted may it use a recent authoritative completed SUCCESS or FAILURE snapshot bound to the same company, PR and stored head. A missing, pending, stale, invalidated or mismatched snapshot remains fail-closed. Permission and provenance checks still apply. A snapshot can lag an undelivered webhook, so it never authorizes APPROVE.

A return admitted from a snapshot records `reviewCiAudit.source` (`budget_exhausted_cached_success` or `budget_exhausted_cached_failure`) and `headSha` in the issue update activity. When admission fails on budget exhaustion, use a backoff of at least 61 minutes instead of immediate retries; distinguish budget reservations from transport calls when diagnosing. See `server/src/myrmidon/review-stage-recovery/github-ci.ts` and `server/src/routes/issues.ts`.

## Continuation cooldown

After three successful continuations without external input, further continuations are deferred for one hour from the latest continuation instead of moving the issue to `blocked`. New external input resets the count. The recovery sweep restores legacy synthetic continuation-cap blocks to `in_progress` only for assigned agent issues without unresolved issue blockers, a pending wake interaction, or an active recovery action. It does not restore real blockers.

Operators should distinguish budget reservations from actual transport calls when investigating exhaustion. The incident's reported 2000 reservations with zero transport calls in the rejected attempt do not identify the consumers of the whole window. Production attribution and rollout require operator evidence; no production state was changed by this PR.
