import { z } from "zod";

/**
 * Schema for a single plugin entitlement key
 */
export const pluginEntitlementKeySchema = z.object({
  key: z.string().min(1),
  pluginId: z.string().min(1),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime().nullable(),
  status: z.enum(["valid", "expired", "invalid"]),
});

/**
 * Schema for plugin entitlement keys stored in instance settings
 */
export const pluginEntitlementKeysSchema = z.array(pluginEntitlementKeySchema).default([]);

export type PluginEntitlementKey = z.infer<typeof pluginEntitlementKeySchema>;
export type PluginEntitlementKeys = z.infer<typeof pluginEntitlementKeysSchema>;