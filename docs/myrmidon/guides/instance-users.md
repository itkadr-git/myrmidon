# Instance users

The Instance users screen is a cross-workspace directory for instance administrators. It is separate from Company settings > Users (`/company/settings/users`): that existing screen manages users and invitations in the selected company, while this screen searches the instance-wide user directory.

Open `/company/settings/instance/users` to view **Instance users**. The navigation item is rendered only for instance administrators. The page reads directory results through the existing `accessApi.searchAdminUsers` API; it does not add user-management actions.

The page shows a loading state while a search is running, an empty state when no users match, and an error state when the request fails. A 403 response is shown as an access-denied error rather than exposing directory data. Non-instance-administrators should not see the navigation item, and the server remains authoritative if they reach the route directly.