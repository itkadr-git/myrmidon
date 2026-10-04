# Autonomy Matrix DELETE Route Mapping

This table shows the mapping between DELETE routes and their corresponding autonomy action class.

| Route | Method | Action Class | Guard | Notes |
|-------|--------|--------------|-------|-------|
| `/api/issues/:id` | DELETE | `delete` | `assertAgentIssueMutationAllowed` | Deletes an entire issue |
| `/api/issues/:id/comments/:commentId` | DELETE | `delete` | `assertAgentIssueMutationAllowed` | Deletes a specific comment from an issue |
| `/api/attachments/:attachmentId` | DELETE | `delete` | `assertDeliverableMutationAllowedByRunContext` | Removes an attachment from an issue |
| `/api/issues/:id/watchdog` | DELETE | `delete` | `assertAgentIssueMutationAllowed` | Removes a watchdog timer from an issue |
| `/api/work-products/:id` | DELETE | `delete` | `assertAgentIssueMutationAllowed` | Removes a work product |
| `/api/issues/:id/approvals/:approvalId` | DELETE | `delete` | `assertAgentIssueMutationAllowed` | Removes an approval from an issue |
| `/api/issues/:id/documents/:key` | DELETE | N/A | `req.actor.type !== "board"` | Removes a document from an issue - board only |
| `/api/agents/:id` | DELETE | N/A | `assertBoard` | Removes an agent - board only |
| `/api/agents/:id/keys/:keyId` | DELETE | N/A | `assertBoard` | Removes an agent key - board only |
| `/api/agents/:id/instructions-bundle/file` | DELETE | N/A | `assertCanManageInstructionsPath` + `assertExternalInstructionsAdmin` | Removes an instruction file - requires special permissions |

All agent-accessible routes enforce the `delete` action class via `dbAutonomyGate(db).assertAllowed(req, "delete")` call.