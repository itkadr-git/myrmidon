# User Administration & Audit Log (users-admin-a)

## Overview

The `users-admin-a` module provides instance-level user management and audit logging for administrators. Because public self-registration is disabled, administrators provision and manage user accounts directly.

Every administrative action is recorded in the activity log with actor details, target details, timestamp, and metadata.

## Endpoints

### 1. User Directory & Creation

- `GET /api/myrmidon/users-admin-a/users`
  - Requires instance administrator privileges.
  - Lists all users with their roles (`instance_admin` or `member`), blocked state, display names, and creation timestamps.

- `POST /api/myrmidon/users-admin-a/users`
  - Creates a new user account.
  - Body: `{ username, name, password?, role? }`
  - If password is omitted, generates a one-time password setup link (`passwordSetLink`).
  - Audit event: `instance.user.created`.

### 2. User Modification & Access Control

- `PATCH /api/myrmidon/users-admin-a/users/:userId`
  - Updates user state.
  - Body fields (at least one required):
    - `blocked`: boolean (blocks or unblocks the user; revokes active sessions and API keys).
    - `resetPassword`: boolean (invalidates existing password, generates a one-time setup token).
    - `role`: `"instance_admin" | "member"` (promotes or demotes user role; self-demotion and demoting the last admin are rejected with 409).
  - Audit events:
    - `instance.user.blocked` / `instance.user.unblocked`
    - `instance.user.password_reset`
    - `instance.user.role_changed` (records `previousRole` and `newRole`)

### 3. Password Setup

- `POST /api/myrmidon/users-admin-a/password-set`
  - Public endpoint allowing users with a valid one-time token to set their password.
  - Body: `{ token, newPassword }`
  - Audit event: `instance.user.password_set`.

### 4. Audit Log API

- `GET /api/myrmidon/users-admin-a/audit`
  - Requires instance administrator privileges.
  - Query parameters:
    - `userId`: Filter by target user ID (`entityId`).
    - `actorId`: Filter by author user ID (`actorId`).
    - `action`: Filter by specific event name (e.g. `instance.user.created`, `instance.user.role_changed`).
    - `limit`: Number of records to return (1..200, default 50).
  - Deduplication: Automatically deduplicates fan-out journal rows across multiple companies.
  - Enrichment: Enriches actor and target records with current username and display name.

## UI Interface

The management UI is available at `/company/settings/users` and contains two main tabs:

1. **Users**:
   - Form to create new users with optional initial password or one-time setup link.
   - User directory with search by name/username/email.
   - Action buttons per user: Block/Unblock, Make Admin/Remove Admin, and Reset Password.
2. **Audit Log**:
   - Filters by target user, author, and action type.
   - Table displaying timestamp, action badge, target user, author, and action details.
