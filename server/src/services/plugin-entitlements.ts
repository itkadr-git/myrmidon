import { eq, and, isNotNull } from 'drizzle-orm';
import { pluginEntitlements } from '@paperclipai/db';
import { logger } from '../middleware/logger.js';
import { z } from 'zod';
import { promisify } from 'util';
import { randomBytes } from 'crypto';

// Cache for entitlement checks with TTL
const entitlementCache = new Map<string, { entitled: boolean; timestamp: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Define dependency interface
export interface PluginEntitlementServiceDeps {
  db: any; // typeof import('@paperclipai/db').db;
  getServerInstance(): string;
}

/**
 * Check if a plugin is entitled for use in the current instance
 * @param pluginKey - The plugin identifier to check
 * @param deps - Dependencies for the function
 * @returns Promise<boolean> - True if entitled, false otherwise
 */
export async function isEntitled(pluginKey: string, deps: PluginEntitlementServiceDeps): Promise<boolean> {
  const { db, getServerInstance } = deps;
  
  // Check cache first
  const cacheKey = `${getServerInstance()}:${pluginKey}`;
  const cached = entitlementCache.get(cacheKey);
  
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.entitled;
  }

  try {
    const now = new Date();
    const instanceId = getServerInstance();
    
    // Query for active entitlements for this plugin and instance
    const result = await db
      .select()
      .from(pluginEntitlements)
      .where(
        and(
          eq(pluginEntitlements.pluginId, pluginKey),
          eq(pluginEntitlements.instanceId, instanceId),
          isNotNull(pluginEntitlements.expiresAt),
        )
      )
      .orderBy(pluginEntitlements.expiresAt);

    // Check if any active entitlement exists (not expired)
    const hasValidEntitlement = result.some(entitlement => 
      new Date(entitlement.expiresAt) > now
    );

    // Cache the result
    entitlementCache.set(cacheKey, {
      entitled: hasValidEntitlement,
      timestamp: Date.now()
    });

    return hasValidEntitlement;
  } catch (error) {
    logger.error(`Error checking entitlement for plugin ${pluginKey}:`, error);
    // In case of error, deny access for security
    return false;
  }
}

/**
 * Verify an entitlement key using Ed25519 signature verification
 * @param entitlementKey - The signed entitlement token
 * @param publicKey - The public key to verify the signature
 * @returns Promise<boolean> - True if signature is valid
 */
export async function verifyEntitlementSignature(
  entitlementKey: string, 
  publicKey: string
): Promise<boolean> {
  try {
    // Parse the entitlement key which should be in the format: 
    // base64(payload).base64(signature)
    const parts = entitlementKey.split('.');
    if (parts.length !== 2) {
      return false;
    }

    const [payloadB64, signatureB64] = parts;
    
    // Decode base64 components
    const payloadBuffer = Buffer.from(payloadB64, 'base64');
    const signatureBuffer = Buffer.from(signatureB64, 'base64');
    const publicKeyBuffer = Buffer.from(publicKey, 'base64');

    // Import the crypto module
    const { verify } = await import('crypto');
    
    // Verify the signature using Ed25519 algorithm
    const isValid = verify(null, payloadBuffer, publicKeyBuffer, signatureBuffer);
    
    return isValid;
  } catch (error) {
    logger.error('Error verifying entitlement signature:', error);
    return false;
  }
}

/**
 * Generate a new entitlement key (for testing purposes)
 * @param pluginId - The plugin identifier
 * @param instanceId - The instance identifier
 * @param expiresAt - Expiration date
 * @param deps - Dependencies for the function (optional, for testing)
 * @returns Promise<{entitlementKey: string, publicKey: string, privateKey: string}>
 */
export async function generateEntitlementKey(
  pluginId: string,
  instanceId: string,
  expiresAt: Date,
  deps?: PluginEntitlementServiceDeps
): Promise<{ entitlementKey: string; publicKey: string; privateKey: string }> {
  try {
    // Import crypto module
    const { generateKeyPairSync } = await import('crypto');
    
    // Generate Ed25519 key pair
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    
    // Create payload with plugin ID, instance ID, and expiration
    const payload = {
      pluginId,
      instanceId,
      expiresAt: expiresAt.toISOString(),
      issuedAt: new Date().toISOString(),
    };
    
    // Convert payload to buffer
    const payloadBuffer = Buffer.from(JSON.stringify(payload));
    
    // Sign the payload
    const sign = privateKey.sign(payloadBuffer);
    
    // Encode as base64
    const payloadB64 = payloadBuffer.toString('base64');
    const signatureB64 = sign.toString('base64');
    
    // Create the entitlement key in format: payload.signature
    const entitlementKey = `${payloadB64}.${signatureB64}`;
    
    return {
      entitlementKey,
      publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    };
  } catch (error) {
    logger.error('Error generating entitlement key:', error);
    throw error;
  }
}

/**
 * Clear the entitlement cache (useful when entitlements are modified)
 */
export function clearEntitlementCache(): void {
  entitlementCache.clear();
}

/**
 * Get all entitlements for a plugin
 * @param pluginId - The plugin identifier
 * @param deps - Dependencies for the function
 * @returns Promise<PluginEntitlement[]>
 */
export async function getPluginEntitlements(pluginId: string, deps: PluginEntitlementServiceDeps): Promise<any[]> {
  const { db, getServerInstance } = deps;
  try {
    const instanceId = getServerInstance();
    
    const entitlements = await db
      .select()
      .from(pluginEntitlements)
      .where(
        and(
          eq(pluginEntitlements.pluginId, pluginId),
          eq(pluginEntitlements.instanceId, instanceId)
        )
      );
      
    return entitlements;
  } catch (error) {
    logger.error(`Error fetching entitlements for plugin ${pluginId}:`, error);
    return [];
  }
}