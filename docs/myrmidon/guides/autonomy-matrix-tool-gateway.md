# Autonomy Matrix Integration in Tool Gateway

## Overview

The autonomy matrix controls which actions agents are allowed to perform based on their role. With this integration, specific tool calls are now classified into action classes (`merge`, `deploy`, `external_message`, etc.) and checked against the autonomy matrix before execution.

## Action Classes

The following action classes are defined in the autonomy matrix:

- `merge` - Pull request and Git operations
- `deploy` - Deployment-related actions
- `external_message` - Communications sent outside the system (email, Slack, etc.)
- `spend_above_threshold` - Financial transactions
- `delete` - Deletion operations
- `pause_wake_agents` - Agent lifecycle management
- `change_instructions` - Changes to agent instructions
- `other` - Catch-all for unmapped tools

## Tool Classification

Tools are mapped to action classes using a configurable mapping system. Default mappings are provided for common tools:

- **Merge tools**: `github.create_pr`, `github.merge_pr`, `git.push`, etc.
- **Deploy tools**: `deploy.apply`, `kubernetes.deploy`, `vercel.deploy`, etc.
- **External message tools**: `email.send`, `slack.send_message`, `notification.send`, etc.

## Enforcement Points

The autonomy matrix is checked in the tool gateway when:

1. An agent attempts to execute a tool
2. The tool is mapped to an action class
3. The agent's role has a specific verdict for that action class

## Verdict Handling

- `allowed` - Tool executes normally
- `approval_required` - Tool execution is paused and an approval request is created
- `forbidden` - Tool execution is denied with a 403 error and `autonomy_forbidden` code

## Configuration

The tool-to-action-class mapping is configurable via the `DEFAULT_TOOL_AUTONOMY_MAPPING` constant and can be extended with custom mappings.

## Testing

Each autonomy matrix verdict is tested to ensure proper enforcement:

- Forbidden actions throw 403 errors
- Approval-required actions create approval requests
- Allowed actions execute normally
- Unmapped tools continue to work as before