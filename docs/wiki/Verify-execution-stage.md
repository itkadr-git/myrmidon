# Verify execution stage (VERIFY-ON-PROD)

> Русская версия: [Verify-execution-stage.ru](Verify-execution-stage.ru)

The verification execution stage (`verify`) ensures that changes delivered by release tasks are verified on an actual deployed build before the task can be completed. It provides an automated quality gate between code review/merge and final task closure (OPE-12995).

## Overview

In Myrmidon's execution policy model, a task advances through structured stages after work is completed. While the `review` stage verifies code quality before merge and the `approval` stage provides managerial sign-off, the `verify` stage validates the actual behavior on a deployed environment (staging or production).

| Stage Type | Purpose | When Enforced |
|---|---|---|
| `review` | Code review and pull request approval | Before merge |
| `verify` | Operational verification on deployed release version | After deploy / before `done` |
| `approval` | Stakeholder / lead authorization | Final sign-off |

## Stage Configuration

A verify stage is configured in the issue's `executionPolicy.stages` array:

```json
{
  "mode": "normal",
  "stages": [
    {
      "type": "review",
      "approvalsNeeded": 1,
      "participants": [{ "type": "agent", "agentId": "d674a53a-3abd-43fe-8f49-696a04937323" }]
    },
    {
      "type": "verify",
      "approvalsNeeded": 1,
      "participants": [{ "type": "agent", "agentId": "07555686-c5f7-4536-ac2b-c9ab1027e89f" }],
      "requirements": {
        "deployVersion": true,
        "checkMethod": true,
        "skip": false
      }
    }
  ]
}
```

### Stage Schema Fields

- **`type`**: Must be `"verify"`.
- **`approvalsNeeded`**: Currently `1`.
- **`participants`**: List of eligible verifiers (`agent` or `user`).
- **`requirements`**: Optional configuration object controlling evidence and bypass rules:
  - **`deployVersion`** (`boolean`): If `true`, the verifier must record the deployed version tested against.
  - **`checkMethod`** (`boolean`): If `true`, the verifier must record the method used to verify.
  - **`skip`** (`boolean`): When set to `true`, explicitly allows bypassing verification for non-code tasks (documentation, configuration changes).

## Verifier Independence

To maintain verification integrity, the runtime enforces the `REVIEW-INDEPENDENCE` rule:
- The verifying participant **must differ** from the task executor (`assignee`, `returnAssignee`, or the agent submitting the work).
- An executor cannot approve their own verification stage. Any attempt by the author/assignee to submit a verify decision returns `422 Unprocessable Entity`.
- When waking the assigned verifier, the runtime issues a wakeup with `wakeRole: "verifier"` and reason `execution_verify_requested`.

## Required Evidence on Approval

When a verifier marks their review complete by transitioning the issue status to `done`, the decision comment must contain the required verification evidence:

1. **Deploy Version**: Must specify the deployed version or commit tested.
   - Matched by case-insensitive pattern: `deploy version: <value>`, `deploy_version: <value>`, `version: <value>`.
2. **Check Method**: Must specify the testing method or command used.
   - Matched by case-insensitive pattern: `check method: <value>`, `check_method: <value>`, `method: <value>`.

### Decision Comment Example

```text
Approved verification on deployed environment.
Deploy version: 2026.11.14-rc.3
Check method: Manual smoke check on board UI and API health check
All acceptance criteria verified against live instance.
```

### Automatic Enforcement on Release Tasks

For release tasks (tasks whose title matches the release naming convention via `isReleaseTask`), both `deployVersion` and `checkMethod` requirements are **mandatory by default**, even if omitted in the issue's explicit stage configuration. If either field is missing from the approval comment, the API rejects the transition with `422 Unprocessable Entity` indicating the missing requirement.

## Return Path on Rejection (Changes Requested)

If verification reveals a defect or regression:

1. The verifier transitions the issue to `in_progress` (or another active non-done status) with an explanatory comment describing the failure.
2. The runtime records the decision outcome as `changes_requested`.
3. The issue is automatically reassigned back to the original executor (`returnAssignee`).
4. The executor is woken with reason `execution_changes_requested` and role `executor`.
5. Once the executor fixes the issue and submits (`PATCH status: "in_review"`), the runtime routes the task directly back to the active verify stage with the assigned verifier.

## Skip Semantics (`requirements.skip`)

Certain release tasks involve no code changes or deployments (for example, documentation updates, wiki guides, or settings adjustments). In these cases:

- Setting `requirements: { "skip": true }` on the verify stage explicitly informs the runtime that verification is not required.
- When `skip` is `true`, the gate checks are bypassed, allowing the issue to settle to `done` without failing release policy enforcement.
- A verify stage without `skip: true` will never be silently auto-skipped.

## Done Gate for Release Tasks

The runtime blocks any attempt to transition a release task with code work products directly to `done` if:
1. No `verify` stage is configured in `executionPolicy.stages`, AND
2. No verify stage declares `requirements.skip: true`.

Attempting to close an unverified release task returns:
```text
HTTP 422 Unprocessable Entity: Cannot mark release task done without a verify execution stage. A release task requires an independent verification stage with deploy version and check method, or an explicit skip configuration.
```

## Related References

- [Execution Policy Guide](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/../guides/execution-policy.md)
- [Tasks and the Board](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/wiki/Tasks-and-the-board.md)
- [Task PR Sync](Task-pr-sync)
