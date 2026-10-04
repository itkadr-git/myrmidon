# Autonomy Matrix DELETE Action Enforcement

## Overview

Starting with version 1.6.2, the autonomy matrix enforces the `delete` action class on various DELETE endpoints. Agents whose roles have `delete` set to `forbidden` in the autonomy matrix will receive a 403 error when attempting to delete resources via API endpoints.

## Affected Endpoints

The following DELETE endpoints now check the autonomy matrix for the `delete` action class:

| Endpoint | Description |
|----------|-------------|
| `DELETE /api/issues/:id` | Delete an issue |
| `DELETE /api/issues/:id/comments/:commentId` | Delete a comment from an issue |
| `DELETE /api/attachments/:attachmentId` | Delete an attachment |
| `DELETE /api/issues/:id/inbox-archive` | Unarchive an inbox item |

## Configuration

Configure the delete permission in the autonomy matrix:

```json
{
  "rules": [
    {
      "role": "your-agent-role",
      "actionClass": "delete",
      "verdict": "allowed" // or "forbidden" or "approval_required"
    }
  ],
  "defaults": {
    "delete": "allowed"
  }
}
```

## Response Format

When an agent attempts a DELETE operation that is forbidden by the autonomy matrix, the API returns:

```json
{
  "error": "This action is forbidden for this role by the autonomy matrix",
  "code": "autonomy_forbidden",
  "actionClass": "delete",
  "role": "agent-role-name"
}
```

## Behavior

- **Allowed**: The DELETE operation proceeds normally
- **Forbidden**: The operation is denied with a 403 response
- **Approval Required**: Currently treated as forbidden (future enhancement may support approval workflow)

## Board User Access

Board users (non-agent API callers) are not subject to autonomy matrix restrictions and can perform DELETE operations regardless of the matrix configuration.
