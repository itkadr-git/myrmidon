import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { isEntitled, verifyEntitlementSignature, generateEntitlementKey, clearEntitlementCache } from './plugin-entitlements.js';
import { eq, and, isNotNull } from 'drizzle-orm';
import { getServerInstance } from '../utils/instance.js';

vi.mock('@paperclipai/db', async () => {
  const actual = await vi.importActual('@paperclipai/db');
  return {
    ...actual,
    db: {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
    },
  };
});

// Import the actual db object for typing
import { db } from '@paperclipai/db';
import { pluginEntitlements } from '@paperclipai/db';

vi.mock('../db', () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
  },
}));

vi.mock('../utils/instance', () => ({
  getServerInstance: vi.fn().mockReturnValue('test-instance-123'),
}));

describe('Plugin Entitlement Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearEntitlementCache();
  });

  describe('isEntitled', () => {
    it('should return true when plugin has valid entitlement', async () => {
      // Mock DB response with valid entitlement
      const mockEntitlement = {
        id: 'ent-123',
        pluginId: 'test-plugin',
        instanceId: 'test-instance-123',
        expiresAt: new Date(Date.now() + 86400000), // Tomorrow
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(db.select().from().where().orderBy).mockResolvedValue([mockEntitlement]);

      const result = await isEntitled('test-plugin');
      expect(result).toBe(true);
    });

    it('should return false when plugin has no entitlement', async () => {
      vi.mocked(db.select().from().where().orderBy).mockResolvedValue([]);

      const result = await isEntitled('non-existent-plugin');
      expect(result).toBe(false);
    });

    it('should return false when plugin has expired entitlement', async () => {
      const mockExpiredEntitlement = {
        id: 'ent-123',
        pluginId: 'test-plugin',
        instanceId: 'test-instance-123',
        expiresAt: new Date(Date.now() - 86400000), // Yesterday
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(db.select().from().where().orderBy).mockResolvedValue([mockExpiredEntitlement]);

      const result = await isEntitled('test-plugin');
      expect(result).toBe(false);
    });
  });

  describe('verifyEntitlementSignature', () => {
    it('should return true for valid Ed25519 signature', async () => {
      // We'll test this by generating a key pair and signing a payload
      const { entitlementKey, publicKey } = await generateEntitlementKey(
        'test-plugin',
        'test-instance',
        new Date(Date.now() + 86400000) // Tomorrow
      );

      const result = await verifyEntitlementSignature(entitlementKey, publicKey);
      expect(result).toBe(true);
    });

    it('should return false for invalid signature format', async () => {
      const result = await verifyEntitlementSignature('invalid-format', 'public-key');
      expect(result).toBe(false);
    });

    it('should return false for tampered signature', async () => {
      const { entitlementKey, publicKey } = await generateEntitlementKey(
        'test-plugin',
        'test-instance',
        new Date(Date.now() + 86400000) // Tomorrow
      );

      // Tamper with the payload part of the entitlement key
      const tamperedKey = entitlementKey.replace(/\.(.*)$/, '.dGVzdC1zaWduYXR1cmU=');
      
      const result = await verifyEntitlementSignature(tamperedKey, publicKey);
      expect(result).toBe(false);
    });
  });

  describe('generateEntitlementKey', () => {
    it('should generate a valid entitlement key with correct structure', async () => {
      const pluginId = 'test-plugin';
      const instanceId = 'test-instance';
      const expiresAt = new Date(Date.now() + 86400000); // Tomorrow

      const result = await generateEntitlementKey(pluginId, instanceId, expiresAt);

      expect(result).toHaveProperty('entitlementKey');
      expect(result).toHaveProperty('publicKey');
      expect(result).toHaveProperty('privateKey');
      
      // Check that the entitlement key has the expected format (payload.signature)
      expect(result.entitlementKey).toMatch(/^\S+\.\S+$/);
    });
  });

  describe('cache behavior', () => {
    it('should cache entitlement checks', async () => {
      const mockEntitlement = {
        id: 'ent-123',
        pluginId: 'cached-plugin',
        instanceId: 'test-instance-123',
        expiresAt: new Date(Date.now() + 86400000), // Tomorrow
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Mock the first call
      vi.mocked(db.select().from().where().orderBy).mockResolvedValueOnce([mockEntitlement]);
      
      // First call should hit the DB
      const result1 = await isEntitled('cached-plugin');
      expect(result1).toBe(true);
      
      // Reset the mock to return empty for subsequent calls
      vi.mocked(db.select().from().where().orderBy).mockResolvedValue([]);
      
      // Second call should use cache
      const result2 = await isEntitled('cached-plugin');
      expect(result2).toBe(true);
    });
  });
});