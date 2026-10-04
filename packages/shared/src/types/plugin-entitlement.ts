import { z } from 'zod';

// Plugin entitlement-related types
export const pluginEntitlementSchema = z.object({
  id: z.string().uuid(),
  pluginId: z.string(),
  entitlementKey: z.string(), // This would typically be hashed in storage
  publicKey: z.string(), // Public key for signature verification
  instanceId: z.string(),
  expiresAt: z.string().datetime({ offset: true }), // ISO 8601 datetime with timezone
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

export type PluginEntitlement = z.infer<typeof pluginEntitlementSchema>;

// Extended plugin manifest interface with entitlement requirement
export interface PluginManifestWithEntitlement extends PluginManifest {
  requiresEntitlement?: boolean; // Flag indicating if this plugin requires an entitlement key
}

// Request/response types for entitlement API
export const createEntitlementRequestSchema = z.object({
  pluginId: z.string(),
  entitlementKey: z.string(),
  publicKey: z.string(),
  instanceId: z.string(),
  expiresAt: z.string().datetime({ offset: true }),
});

export type CreateEntitlementRequest = z.infer<typeof createEntitlementRequestSchema>;

export const entitlementApiResponseSchema = z.object({
  id: z.string().uuid(),
  pluginId: z.string(),
  instanceId: z.string(),
  expiresAt: z.string().datetime({ offset: true }),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

export type EntitlementApiResponse = z.infer<typeof entitlementApiResponseSchema>;