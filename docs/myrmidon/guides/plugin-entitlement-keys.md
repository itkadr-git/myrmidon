# Plugin Entitlement Keys

Plugin Entitlement Keys allow administrators to control which plugins are enabled on the instance. This feature enables a licensing model where certain premium plugins require a valid entitlement key to be active.

## Overview

The Plugin Entitlement system allows:
- Adding license keys for plugins that require them
- Viewing the status of each plugin (enabled, needs key, key expired)
- Managing plugin keys from the instance settings page

## Adding a Plugin Key

1. Navigate to Instance Settings → Plugin Entitlement Keys
2. Enter your plugin license key in the input field
3. Click "Add Key"

The system will automatically associate the key with the appropriate plugin based on the key format.

## Key Format

Plugin keys follow the format: `PC-{PLUGIN_ID}-{EXPIRY_DATE}-{CHECKSUM}`
- `PC-`: Prefix indicating this is a Paperclip key
- `{PLUGIN_ID}`: The ID of the plugin the key is for
- `{EXPIRY_DATE}`: Optional expiration date in YYYYMMDD format
- `{CHECKSUM}`: Validation checksum

Example: `PC-enterprise-features-20251231-A1B2C3D4E5F`

## Plugin Manifest Integration

Plugins that require entitlement keys should include the `requiresEntitlement: true` field in their manifest:

```json
{
  "id": "paperclip.enterprise-features",
  "requiresEntitlement": true,
  // ... other manifest fields
}
```

## Status Indicators

- **Valid**: Plugin is enabled and the key is valid
- **Expired**: Plugin is disabled because the key has expired
- **Invalid**: Plugin is disabled because the key is invalid or malformed