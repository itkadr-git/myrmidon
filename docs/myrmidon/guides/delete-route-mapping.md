# Autonomy Matrix DELETE Route Mapping

This table shows the mapping between DELETE routes and their corresponding autonomy action class.

| Route | Method | Action Class | Notes |
|-------|--------|--------------|-------|
| `/api/issues/:id` | DELETE | `delete` | Deletes an entire issue |
| `/api/issues/:id/comments/:commentId` | DELETE | `delete` | Deletes a specific comment from an issue |
| `/api/attachments/:attachmentId` | DELETE | `delete` | Removes an attachment from an issue |
| `/api/issues/:id/inbox-archive` | DELETE | `delete` | Unarchives an inbox item |

All routes enforce the `delete` action class via `dbAutonomyGate(db).assertAllowed(req, "delete")` call.
