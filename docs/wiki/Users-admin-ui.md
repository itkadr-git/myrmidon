# Company Users administration: the owner's screen (1.7 USERS-ADMIN-UI B)

> Русская версия: [Users-admin-ui.ru](Users-admin-ui.ru)

The **Users** screen (`/company/settings/users`) is the central user administration panel for instance administrators in Myrmidon. Because public self-registration is disabled, all user accounts are provisioned and managed directly by administrators.

## Access and Navigation

- **Navigation**: Company settings sidebar → **Users** (`/company/settings/users`).
- **Permissions**: Visible only to instance administrators (`isInstanceAdmin`).
- **Direct access**: Non-administrators who access the route directly receive an HTTP 403 access-denied message: *"Instance administrator access is required to manage users."*
- **Relation to Instance users**: This screen manages interactive user accounts, credentials, and permissions in the board interface. It is distinct from the cross-workspace directory at `/company/settings/instance/users` ([instance-users.md](Instance-users)), which only performs read-only lookups across the instance.

## Creating Users

The **Create user** form provides account provisioning for new team members:

1. **Username**: Unique identifier used for authentication and `@`-mentions (`username.trim()`).
2. **Display name**: Human-readable name displayed across the board (`name.trim()`).
3. **Role**:
   - **User** (`member`): Standard workspace member permissions.
   - **Administrator** (`instance_admin`): Instance-level administration permissions.
4. **Temporary password (optional)**:
   - When a password is provided: The user can immediately sign in with the initial password.
   - When left blank: Myrmidon generates a secure, one-time setup link (`passwordSetLink`).

### One-Time Password Setup Link

When a user is created without a temporary password (or when their password is reset):
- An ephemeral setup banner is displayed at the top of the page.
- Notice: *"Copy this link now. It is shown only once and is not retained here."*
- Actions:
  - **Copy link**: Copies the setup URL directly to the clipboard via the shared clipboard helper.
  - **Dismiss**: Clears the banner from view.
- The link directs the recipient to the public setup endpoint (`/myrmidon/users-admin-a/password-set`), where they choose their own password.

## User Directory and Search

The **User directory** panel displays all registered users on the board:

- **Search**: Real-time filtering by name, username, or email address.
- **Counter**: Displays the total count of matching accounts (`N users`).
- **User entry details**:
  - Display name and `@username`.
  - Email address (or synthetic email placeholder).
  - Status badges:
    - **Blocked** (destructive badge): The account is currently suspended.
    - **Administrator** (primary badge): Instance administrator role (`instance_admin`).
    - **User** (primary badge): Standard member role (`member`).

## Account Actions

Administrators can perform actions directly on any user in the directory:

- **Block / Unblock**:
  - Toggles the `blocked` status of the account.
  - Blocking immediately terminates all active web sessions for the user and revokes their active API keys.
  - Logs `instance.user.blocked` or `instance.user.unblocked` audit events.
- **Reset password**:
  - Invalidates the user's current password.
  - Generates a fresh one-time setup link (`passwordSetLink`) and presents it in the top setup banner.
  - Logs an `instance.user.password_reset` audit event.
- **Role assignment**:
  - Toggle between `member` and `instance_admin`.
  - Self-demotion guard: Administrators cannot demote their own account.
  - Last administrator guard: The system rejects demoting the final remaining administrator (HTTP 409 Conflict).
  - Logs an `instance.user.role_changed` audit event.

## Audit Log and Backend

All mutating actions performed on this screen are persisted to the instance activity log. For details on backend endpoints, deduplication across companies, and the audit query API, see [users-admin-a.md](Users-admin-a).

## Code and Verification

- Page component: `ui/src/pages/UsersAdmin.tsx`
- Routing: `ui/src/App.tsx` (`/company/settings/users`)
- Navigation sidebar: `ui/src/components/CompanySettingsSidebar.tsx` and test `ui/src/components/CompanySettingsSidebar.test.tsx`
- Backend API tests: `server/src/__tests__/users-admin-a-routes.test.ts`
