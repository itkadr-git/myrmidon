import express from 'express';
import { body, param, validationResult } from 'express-validator';
import { db } from '@paperclipai/db';
import { pluginEntitlements } from '@paperclipai/db';
import { eq, and } from 'drizzle-orm';
import { getServerInstance } from '../../utils/instance.js';
import { logger } from '../../utils/logger.js';
import { isEntitled, verifyEntitlementSignature, clearEntitlementCache } from '../plugin-entitlements.js';

const router = express.Router();

// Validation middleware
const validateEntitlementInput = [
  body('pluginId').isString().withMessage('Plugin ID must be a string'),
  body('entitlementKey').isString().withMessage('Entitlement key must be a string'),
  body('publicKey').isString().withMessage('Public key must be a string'),
  body('instanceId').isString().withMessage('Instance ID must be a string'),
  body('expiresAt').isISO8601().withMessage('Expires at must be a valid ISO 8601 date'),
];

// POST /api/plugin-entitlements - Add a new entitlement
router.post('/', validateEntitlementInput, async (req, res) => {
  try {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

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
router.get('/:pluginId', [
  param('pluginId').isString().withMessage('Plugin ID must be a string'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

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
router.get('/', async (req, res) => {
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
router.delete('/:id', [
  param('id').isString().withMessage('Entitlement ID must be a string'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

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

export default router;