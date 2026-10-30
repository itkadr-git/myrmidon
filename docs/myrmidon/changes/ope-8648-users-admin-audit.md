# OPE-8648: User Administration Audit Log and Role Management

## Summary
- Implemented `GET /api/myrmidon/users-admin-a/audit` endpoint for listing user management audit records from `activity_log`.
- Added audit event emission for `instance.user.role_changed` with `previousRole` and `newRole`.
- Added role update support (`role: "instance_admin" | "member"`) in `PATCH /api/myrmidon/users-admin-a/users/:userId`.
- Added prevention of self-demotion and demoting the last instance administrator.
- Added audit log query filters: `userId` (target), `actorId` (author), `action`, and `limit`.
- Added deduplication of fan-out activity log entries across multiple companies.
- Added Users and Audit Log tabs to `/company/settings/users` UI with role management and filters.
- Enriched audit log entries with author and target user display names and usernames.
- Added integration tests covering role management, audit logging, and audit query filtering.
