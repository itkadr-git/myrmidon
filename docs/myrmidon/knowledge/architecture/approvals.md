# Approvals

## Where in code

- `server/src/routes/approvals.ts:44` defines `approvalRoutes`.
- `server/src/routes/approvals.ts:206` and `:223` implement listing and creation for company-level approvals; `:215` fetches a single approval.
- `server/src/routes/approvals.ts:287`, `:403`, `:438`, and `:465` implement resolution and revision endpoints (`approve`, `reject`, `request-revision`, and `resubmit`).
- `server/src/routes/approvals.ts:278` lists issues linked to an approval; `:500` and `:508` handle approval comments.
- `server/src/services/approvals.ts:11` defines `approvalService`; resolution logic with domain side-effects is in `resolveApproval` at `:44`.
- `server/src/services/issue-approvals.ts:12` defines `issueApprovalService` for linking approvals to issues (`:44`, `:73`, `:107`, `:128`, `:135`).
- `packages/db/src/schema/approvals.ts:5`, `packages/db/src/schema/issue_approvals.ts:7`, and `packages/db/src/schema/approval_comments.ts:6` define the database schemas.

## How it is intended

Approvals serve as an explicit governance and authorization barrier for high-stakes actions within a company, such as agent hiring, terminations, budget modifications, or sensitive tool authorizations. They require board/operator oversight before irreversible actions take effect. Approvals must maintain an immutable audit trail, support request-revision and resubmit review cycles, record decision notes, and allow many-to-many associations with issues so tasks can trace their governing approvals.

## How it is implemented

`approvalService` manages approval records in `approvals` with states `pending`, `revision_requested`, `approved`, and `rejected`. Only board actors (`assertBoard`) can approve, reject, or request revisions. When a revision is requested, the requester can resubmit with an updated payload. When an approval is resolved as `approved`, `resolveApproval` immediately triggers domain side-effects—such as activating agent records via `agentsSvc.activatePendingApproval`, creating agents, configuring monthly budget policies in `budgetService`, or firing `notifyHireApproved`.

Issue linkages are managed separately by `issueApprovalService` in the `issue_approvals` table. A company boundary check ensures issues and approvals belong to the same tenant. Approvals can also host threaded discussions in `approval_comments` to resolve questions before final authorization.

## Difference from the intended design

Approvals operate as a separate governance subsystem parallel to issue-level review policies (`executionPolicy` and `request_confirmation` interactions) rather than being integrated into a unified state machine. Domain side-effects (like agent creation and budget upserts) are tightly coupled inside `approvalService.resolveApproval` instead of being orchestrated via decoupled domain events or workflow hooks. Furthermore, approving or rejecting an approval does not automatically wake or unblock linked issues; dependent agents or operators must separately coordinate issue progress based on approval status.

## Related

- [[comments-interactions]]
- [[issue-store-checkout]]
- [[task-queue]]
- [[inbox-lite]]
