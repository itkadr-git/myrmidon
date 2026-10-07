# AUTONOMY-MATRIX: Holding Actions for Approval

This document describes the functionality that enables the autonomy matrix to hold actions requiring approval, creating approval cards for human review before execution.

## Overview

Starting with version 1.6.2, the autonomy matrix system supports holding actions that require approval. When an agent attempts an action that has the `approval_required` verdict in the autonomy matrix, instead of executing immediately, the system:

1. Creates an approval card (using the existing tool action request mechanism)
2. Returns a 202 response indicating the action is held
3. Stores the action details for later execution
4. Waits for human approval before executing the original action

## Action Classes

The system supports approval requirements for the following action classes:

- `pause_wake_agents`: Pausing, resuming, or waking agents
- Other action classes can be added as needed

## Implementation Details

### Gate Function

The `holdOrAssert` function in the autonomy gate handles the approval workflow:

```typescript
async function holdOrAssert(
  req: Request, 
  actionClass: AutonomyActionClass, 
  descriptor: {
    route: string;
    method: string;
    params?: Record<string, unknown>;
    body?: Record<string, unknown>;
  }
): Promise<{ verdict: AutonomyVerdict; held?: boolean; approvalId?: string }>
```

### API Changes

The following API endpoints now support the autonomy matrix approval workflow:

- `POST /agents/:id/pause`
- `POST /agents/:id/resume` 
- `POST /agents/:id/wakeup`

When these endpoints encounter an action that requires approval, they return a `202 Accepted` response with the following body:

```json
{
  "held": true,
  "approvalId": "unique-approval-id"
}
```

### Approval and Execution

The held action is recorded as a `tool_action_request` paired with a `tool_invocation`
(`tool_name = autonomy_action_<class>`), and the descriptor to replay —
`{ actionClass, route, method, params, body }` — is stored under
`tool_invocations.policy_explanation["myrmidon.autonomy"]` (`arguments_hash` stays a real
SHA-256 of it). Until that request is approved the route does not run: the handler answers
`202` and stops.

On approval the existing review path (`server/src/services/tool-action-review.ts`)
replays the descriptor on behalf of the original actor and marks both rows
(`tool_action_requests.status` → `executed` / `failed`, `tool_invocations.status` →
`succeeded` / `failed`). The action runs **exactly once**: the request is claimed with a
conditional `UPDATE ... WHERE status = 'approved'` (`approved` → `executing`), so a second
approval, or a retry that finds the row no longer `approved`, claims nothing and does
nothing. A rejection never replays the descriptor.

The card is decided through the ordinary action-request approval entry
(`POST /api/tool-gateway/action-requests/:id/approve`, board-only). A held autonomy action
is not a gateway tool — it has no connection, catalog entry or signed arguments — so that
entry hands it to `decideHeldAutonomyAction` instead of the tool conveyor, which would
refuse to verify it and cancel the request. The same branch serves the gateway's recovery
sweep, so a hold that was approved while the process was down is replayed on the next
sweep rather than left stuck. Rejection (`.../decline`) already needed no signed
arguments, and leaves the target untouched.

## Configuration

The autonomy matrix can be configured through the standard matrix editing interface. Set the verdict for any action class to `approval_required` to enable the approval workflow for that action type.