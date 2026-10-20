# Plugin Upgrade Approvals

An instance administrator must approve every capability that a plugin upgrade adds.

## API flow

1. Send `POST /api/plugins/:pluginId/upgrade` without `approvedCapabilities`.
2. If the new package adds capabilities, the server returns `400` and lists the exact capabilities.
3. Review the list, then repeat the request with those same names:

```json
{
  "approvedCapabilities": ["access.members.read"]
}
```

The list must contain every added capability exactly once. Missing, extra, or duplicate names are rejected. An upgrade without new capabilities does not need approval.

The server writes the approving actor, timestamp, and capability list to the activity log. Existing plugin configuration is not removed by the upgrade.

The Plugins page performs the first request, displays the requested capabilities, and offers an `Approve and upgrade` action for instance administrators.