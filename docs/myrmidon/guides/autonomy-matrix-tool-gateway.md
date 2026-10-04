# Autonomy matrix in the tool gateway

## Overview

The autonomy matrix (role × action class → `allowed` / `approval_required` / `forbidden`) is now enforced at the action point: before the tool gateway executes an agent's tool call, the tool is mapped onto an action class and the matrix verdict for the agent's role is resolved. A `forbidden` verdict refuses the call; `approval_required` parks the call in the existing `tool_action_requests` approval conveyor; `allowed` proceeds to the ordinary tool access policy.

Non-agent callers (the board, a test-tab user, an instance admin) are not subject to the matrix: the matrix constrains agents, and the board is the actor that edits it.

## Tool classification

A tool is mapped onto an action class by name:

1. the full gateway tool name (e.g. `mcp.github-1a2b3c4d:merge_pull_request`);
2. otherwise the bare upstream tool name after the last `:` (`merge_pull_request`).

`_` and `-` compare equal, because connected-catalog gateway names slugify the upstream tool name. A tool with no matching entry has **no action class** — it is not governed by the matrix and behaves exactly as before.

Built-in defaults classify exactly the three classes named in the design, with the common tool-name patterns:

- **merge**: `merge_pull_request`, `merge_pr`, `merge`, `update_pull_request`, `update_pull`, `close_pull_request`, `close_pr`, `create_pull_request`, `create_pr`
- **deploy**: `deploy`, `create_deployment`, `create_release`, `publish`, `promote`, `rollback_release`, `kubernetes_apply`, `helm_upgrade`, `terraform_apply`
- **external_message**: `send_message`, `send_chat_message`, `post_message`, `create_message`, `reply_to_message`, `send_email`, `create_email`, `create_issue_comment`, `create_pull_request_comment`, `create_pull_request_review_comment`, `post_tweet`, `create_post`, `publish_message`

The mapping is configurable per instance (see SETTINGS): stored settings win, then the `MYRMIDON_TOOL_AUTONOMY_MAPPING_JSON` env variable (forced override for an instance that never saved the setting), then the built-in defaults. The settings screen shows the effective source.

## Enforcement point

The verdict is resolved in `executeTool` **before** the tool access policy runs (a forbidden cell refuses before any profile, policy, or rate-limit consideration) and before any provider dispatch: a forbidden call never reaches the upstream provider, leaves no invocation in a resumable state and no action request to approve.

Verdict handling:

- `forbidden` → 403 with the stable code `autonomy_forbidden`;
- `approval_required` → the call is recorded, a `tool_action_requests` row and an approval card are created (the existing ask-first path), the caller gets 409 `approval_required`; approving the card re-dispatches the held call through `approvedActionRequestId` and the tool executes;
- `allowed` (and any non-agent caller) → the ordinary policy path, unchanged.

## Audit

Held calls write `tool_gateway.call_approval_required` with the autonomy action class, role, and mapping source; refusals surface `autonomy_forbidden` with the action class and role in the error details.

## Testing

`server/src/services/tool-gateway.myrmidon.test.ts` covers the three acceptance criteria against the real gateway service over an embedded database with a fake remote MCP upstream: the forbidden merge tool is refused (upstream never called), the approval-required external message is parked in `tool_action_requests` and executes after approval, and an unclassified tool runs through the ordinary path even under a fully restrictive matrix.
