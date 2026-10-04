import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { pluginRegistryService } from '../services/plugin-registry.js';
import { isEntitled } from '../services/plugin-entitlements.js';

// Mock the database
const mockDb = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  orderBy: vi.fn().mockReturnThis(),
  insert: vi.fn().mockReturnThis(),
  values: vi.fn().mockReturnThis(),
  returning: vi.fn().mockReturnThis(),
  update: vi.fn().mockReturnThis(),
  set: vi.fn().mockReturnThis(),
  delete: vi.fn().mockReturnThis(),
  then: vi.fn(),
};

vi.mock('../services/plugin-entitlements.js', () => ({
  isEntitled: vi.fn(),
}));

describe('Plugin Registry Service with Entitlement Integration', () => {
  let registry: ReturnType<typeof pluginRegistryService>;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = pluginRegistryService(mockDb as any);
  });

  describe('install', () => {
    it('should install a plugin that does not require entitlement', async () => {
      // Mock entitlement check
      vi.mocked(isEntitled).mockResolvedValue(false);

      const mockManifest = {
        id: 'test-plugin',
        version: '1.0.0',
        apiVersion: 'v1',
        categories: [],
      };

      const mockInput = {
        packageName: '@paperclip/test-plugin',
      };

      // Mock the database operations
      vi.mocked(mockDb.select().from().where()).mockResolvedValue([]);
      vi.mocked(mockDb.insert().values().returning()).mockResolvedValue([{
        id: '123',
        pluginKey: 'test-plugin',
        packageName: '@paperclip/test-plugin',
        version: '1.0.0',
        apiVersion: 'v1',
        categories: [],
        status: 'installed',
        installOrder: 1,
      }]);

      const result = await registry.install(mockInput, mockManifest);

      expect(result).toBeDefined();
      expect(isEntitled).not.toHaveBeenCalled(); // Should not check entitlement for plugin without requirement
    });

    it('should install a plugin that requires entitlement and has valid entitlement', async () => {
      // Mock entitlement check
      vi.mocked(isEntitled).mockResolvedValue(true);

      const mockManifest = {
        id: 'entitled-plugin',
        version: '1.0.0',
        apiVersion: 'v1',
        categories: [],
        configSchema: {
          properties: {
            requiresEntitlement: {
              default: true,
            },
          },
        },
      };

      const mockInput = {
        packageName: '@paperclip/entitled-plugin',
      };

      // Mock the database operations
      vi.mocked(mockDb.select().from().where()).mockResolvedValue([]);
      vi.mocked(mockDb.insert().values().returning()).mockResolvedValue([{
        id: '123',
        pluginKey: 'entitled-plugin',
        packageName: '@paperclip/entitled-plugin',
        version: '1.0.0',
        apiVersion: 'v1',
        categories: [],
        status: 'installed',
        installOrder: 1,
      }]);

      const result = await registry.install(mockInput, mockManifest);

      expect(result).toBeDefined();
      expect(isEntitled).toHaveBeenCalledWith('entitled-plugin');
    });

    it('should reject installation of a plugin that requires entitlement but has no valid entitlement', async () => {
      // Mock entitlement check
      vi.mocked(isEntitled).mockResolvedValue(false);

      const mockManifest = {
        id: 'restricted-plugin',
        version: '1.0.0',
        apiVersion: 'v1',
        categories: [],
        configSchema: {
          properties: {
            requiresEntitlement: {
              default: true,
            },
          },
        },
      };

      const mockInput = {
        packageName: '@paperclip/restricted-plugin',
      };

      await expect(registry.install(mockInput, mockManifest))
        .rejects
        .toThrow('Plugin requires entitlement but none is valid: restricted-plugin');
        
      expect(isEntitled).toHaveBeenCalledWith('restricted-plugin');
    });
  });
});