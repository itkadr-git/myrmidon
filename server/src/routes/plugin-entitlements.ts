import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { eq, and } from "drizzle-orm";
import { pluginEntitlements } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

// Define Zod schemas for validation
const createEntitlementSchema = z.object({
  pluginId: z.string(),
  entitlementKey: z.string(),
  publicKey: z.string(),
  instanceId: z.string(),
  expiresAt: z.string().datetime(),
});

const pluginIdParamSchema = z.object({
  pluginId: z.string(),
});

const entitlementIdParamSchema = z.object({
  id: z.string(),
});

export interface PluginEntitlementRoutesDeps {
  now(): Date;
  getServerInstance(): string;
  isEntitled: (pluginKey: string) => Promise<boolean>;
  verifyEntitlementSignature: (entitlementKey: string, publicKey: string) => Promise<boolean>;
  clearEntitlementCache: () => void;
}

export function pluginEntitlementRoutes(db: Db, deps: PluginEntitlementRoutesDeps) {
  const router = Router();
  const { getServerInstance, isEntitled, verifyEntitlementSignature, clearEntitlementCache } = deps;

  // POST /api/plugin-entitlements - Add a new entitlement
  router.post("/", validate(createEntitlementSchema), async (req, res) => {
    try {
      const { pluginId, entitlementKey, publicKey, instanceId, expiresAt } = req.body;

      // Verify that the instance ID matches the current instance (security check)
      if (instanceId !== getServerInstance()) {
        return res.status(403).json({ error: 'Invalid instance ID' });
      }

      // Verify the entitlement signature
      const isValidSignature = await verifyEntitlementSignature(entitlementKey, publicKey);
      if (!isValidSignature) {
        return res.status(400).json({ error: 'Invalid entitlement signature' });
      }

      // Verify the entitlement hasn't expired
      const expiryDate = new Date(expiresAt);
      if (expiryDate < new Date()) {
        return res.status(400).json({ error: 'Entitlement has expired' });
      }

      // Check if an entitlement already exists for this plugin and instance
      const existingEntitlements = await db
        .select()
        .from(pluginEntitlements)
        .where(
          and(
            eq(pluginEntitlements.pluginId, pluginId),
            eq(pluginEntitlements.instanceId, instanceId)
          )
        );

      if (existingEntitlements.length > 0) {
        return res.status(409).json({ error: 'An entitlement already exists for this plugin and instance' });
      }

      // Insert the new entitlement
      // Note: In production, we wouldn't store the raw entitlement key for security
      // Instead, we'd store a hash of it or just the verification details
      const [newEntitlement] = await db
        .insert(pluginEntitlements)
        .values({
          pluginId,
          entitlementKey: entitlementKey.substring(0, 10) + '...', // Store only partial key for security
          publicKey,
          instanceId,
          expiresAt: expiryDate,
        })
        .returning();

      // Clear cache to refresh entitlement status
      clearEntitlementCache();

      // Return success response (without the actual entitlement key)
      const { entitlementKey: _, ...safeEntitlement } = newEntitlement;
      return res.status(201).json({
        success: true,
        entitlement: safeEntitlement,
      });
    } catch (error) {
      logger.error('Error adding plugin entitlement:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/plugin-entitlements/:pluginId - Check if a plugin is entitled
  router.get("/:pluginId", validate(pluginIdParamSchema), async (req, res) => {
    try {
      const { pluginId } = req.params;

      const entitled = await isEntitled(pluginId);

      return res.json({
        pluginId,
        entitled,
      });
    } catch (error) {
      logger.error('Error checking plugin entitlement:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/plugin-entitlements - Get all entitlements for the current instance
  router.get("/", async (req, res) => {
    try {
      const instanceId = getServerInstance();

      const entitlements = await db
        .select({
          id: pluginEntitlements.id,
          pluginId: pluginEntitlements.pluginId,
          instanceId: pluginEntitlements.instanceId,
          expiresAt: pluginEntitlements.expiresAt,
          createdAt: pluginEntitlements.createdAt,
          updatedAt: pluginEntitlements.updatedAt,
        })
        .from(pluginEntitlements)
        .where(eq(pluginEntitlements.instanceId, instanceId));

      return res.json({
        entitlements,
      });
    } catch (error) {
      logger.error('Error fetching plugin entitlements:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // DELETE /api/plugin-entitlements/:id - Remove an entitlement
  router.delete("/:id", validate(entitlementIdParamSchema), async (req, res) => {
    try {
      const { id } = req.params;
      const instanceId = getServerInstance();

      // Delete the entitlement for the current instance
      const deletedEntitlements = await db
        .delete(pluginEntitlements)
        .where(
          and(
            eq(pluginEntitlements.id, id),
            eq(pluginEntitlements.instanceId, instanceId)
          )
        )
        .returning();

      if (deletedEntitlements.length === 0) {
        return res.status(404).json({ error: 'Entitlement not found' });
      }

      // Clear cache to refresh entitlement status
      clearEntitlementCache();

      return res.json({
        success: true,
        message: 'Entitlement removed successfully',
      });
    } catch (error) {
      logger.error('Error removing plugin entitlement:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

/** The real wiring. */
export function myrmidonPluginEntitlementRoutes(db: Db, deps: PluginEntitlementRoutesDeps) {
  return pluginEntitlementRoutes(db, deps);
}