# Review budget deferral and continuation cooldown

This describes the proposed behavior in PR #4598; it is not deployed until the PR is merged and an operator rolls out its CI-built image.

When a current review participant's decision cannot read CI because the shared review budget is exhausted, the decision remains rejected. An already triggered `Review CI wait` monitor is deferred for 61 minutes and marked as budget-deferred; this is a conservative delay, not a measured reset time. A new PR head releases that particular deferral. Other monitors retain their deadlines. The subsequent decision still needs fresh CI evidence for the exact head; this does not change the budget cap or bypass fail-closed admission.

After three successful continuations without external input, further continuations are deferred for one hour from the latest continuation instead of moving the issue to `blocked`. New external input resets the count. The recovery sweep restores legacy synthetic continuation-cap blocks to `in_progress` only for assigned agent issues without unresolved issue blockers, a pending wake interaction, or an active recovery action. It does not restore real blockers.

Operators should distinguish budget reservations from actual transport calls when investigating exhaustion. The incident's reported 2000 reservations with zero transport calls in the rejected attempt do not identify the consumers of the whole window. Production attribution and rollout require operator evidence; no production state was changed by this PR.
