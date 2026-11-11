# Plugin upgrade capability approvals

An instance administrator must approve every capability added by a plugin upgrade.

## API workflow

1. Send `POST /api/plugins/:pluginId/upgrade` without the `approvedCapabilities` field.
2. If the new package adds capabilities, the server returns `400` along with the exact list of capabilities.
3. Review the list and repeat the request with the exact same names:

```json
{
  "approvedCapabilities": ["access.members.read"]
}
```

The list must contain each newly added capability exactly once. Missing, extra, or duplicate names are rejected. Upgrades that do not add new capabilities require no approval.

The server records the approving user, timestamp, and capability list in the activity log. Existing configuration of the installed plugin is preserved during an upgrade.

On the Plugins page, the initial request runs automatically. After rejection, the requested capabilities and an "Approve and upgrade" button are shown for the instance administrator.
