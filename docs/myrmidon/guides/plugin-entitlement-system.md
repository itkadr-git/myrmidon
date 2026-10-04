# Plugin Entitlement System

## Overview

The Plugin Entitlement System provides a mechanism for controlling access to plugins through cryptographic entitlement keys. This system allows plugin authors to require a valid entitlement key before a plugin can be activated and used within a Myrmidon instance.

## Architecture

### Components

1. **Entitlement Keys**: Cryptographically signed tokens using Ed25519 signatures
2. **Database Storage**: Plugin entitlements are stored in the `plugin_entitlements` table
3. **Validation Service**: The `isEntitled()` service checks plugin access rights
4. **API Routes**: REST endpoints for managing entitlement keys
5. **Plugin Manifest Integration**: Plugins can specify `requiresEntitlement` in their manifest

### Data Structure

The entitlement key contains:
- Plugin ID
- Instance ID
- Expiration timestamp
- Signature (Ed25519)

## Implementation Details

### Entitlement Key Format

Entitlement keys follow the format: `base64(payload).base64(signature)`

The payload contains:
```json
{
  "pluginId": "plugin-identifier",
  "instanceId": "myrmidon-instance-id",
  "expiresAt": "2024-12-31T23:59:59.000Z",
  "issuedAt": "2024-01-01T00:00:00.000Z"
}
```

### Database Schema

The `plugin_entitlements` table includes:
- `id`: Unique identifier for the entitlement
- `plugin_id`: Reference to the plugin
- `entitlement_key`: Hashed storage of the entitlement key
- `public_key`: Public key for signature verification
- `instance_id`: Instance this entitlement is valid for
- `expires_at`: Expiration timestamp
- `created_at`: Creation timestamp
- `updated_at`: Last update timestamp

### Security Features

1. **Cryptographic Verification**: Uses Ed25519 signatures for secure verification
2. **Expiration Checks**: Automatic validation of entitlement validity period
3. **Instance Binding**: Entitlements are tied to specific instances
4. **Secure Storage**: Raw entitlement keys are not stored; only hashes or partial keys
5. **Admin Access Control**: Only instance administrators can manage entitlements

## Usage

### For Plugin Authors

To require an entitlement key for your plugin, add the `requiresEntitlement` property to your plugin manifest:

```typescript
export const manifest: PluginManifest = {
  id: 'premium-plugin',
  name: 'Premium Plugin',
  description: 'A plugin that requires an entitlement key',
  version: '1.0.0',
  requiresEntitlement: true, // This flag indicates the plugin requires an entitlement key
  // ... other manifest properties
};
```

### For Administrators

#### Adding an Entitlement

Use the API endpoint to add a new entitlement:

```
POST /api/plugin-entitlements
```

Request body:
```json
{
  "pluginId": "plugin-identifier",
  "entitlementKey": "entitlement.key.here",
  "publicKey": "public-key-for-verification",
  "instanceId": "your-instance-id",
  "expiresAt": "2024-12-31T23:59:59.000Z"
}
```

#### Checking Plugin Entitlement Status

Check if a plugin is entitled:

```
GET /api/plugin-entitlements/:pluginId
```

#### Listing All Entitlements

Get all entitlements for the current instance:

```
GET /api/plugin-entitlements
```

#### Removing an Entitlement

Remove an entitlement by ID:

```
DELETE /api/plugin-entitlements/:id
```

## Service Methods

### `isEntitled(pluginKey)`

Checks if a plugin is entitled for use in the current instance. Results are cached for 5 minutes.

### `verifyEntitlementSignature(entitlementKey, publicKey)`

Verifies the cryptographic signature of an entitlement key.

### `generateEntitlementKey(pluginId, instanceId, expiresAt)`

Generates a new entitlement key (primarily for testing purposes).

### `clearEntitlementCache()`

Clears the entitlement cache, forcing fresh checks on the next access.

## Testing

Comprehensive tests are included in the `*.myrmidon.test.ts` files to verify:
- Valid entitlement verification
- Invalid signature detection
- Expired entitlement rejection
- Tampered key detection
- Cache behavior
- API endpoint functionality