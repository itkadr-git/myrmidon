import { describe, it, expect } from 'vitest';
import { validatePluginEntitlementKey, isPluginEntitled, addPluginEntitlementKey, removePluginEntitlementKey } from '../../../server/src/myrmidon/plugin-entitlement/validation';

describe('Plugin Entitlement Validation', () => {
  describe('validatePluginEntitlementKey', () => {
    it('should validate a valid key correctly', () => {
      const result = validatePluginEntitlementKey('PC-test-plugin-20251231-ABC123', 'test-plugin');
      expect(result.isValid).toBe(true);
      expect(result.expiresAt).toBeDefined();
    });

    it('should reject an invalid key format', () => {
      const result = validatePluginEntitlementKey('INVALID-KEY-FORMAT', 'test-plugin');
      expect(result.isValid).toBe(false);
      expect(result.expiresAt).toBeNull();
    });

    it('should reject a key for wrong plugin', () => {
      const result = validatePluginEntitlementKey('PC-other-plugin-20251231-ABC123', 'test-plugin');
      expect(result.isValid).toBe(false);
      expect(result.expiresAt).toBeNull();
    });

    it('should detect expired keys', () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0].replace(/-/g, '');
      
      const key = `PC-test-plugin-${yesterdayStr}-ABC123`;
      const result = validatePluginEntitlementKey(key, 'test-plugin');
      expect(result.isValid).toBe(false);
    });
  });

  describe('isPluginEntitled', () => {
    it('should return entitled status for plugin with valid key', () => {
      const keys = [
        {
          key: 'PC-test-plugin-20251231-ABC123',
          pluginId: 'test-plugin',
          issuedAt: new Date().toISOString(),
          expiresAt: null,
          status: 'valid' as const
        }
      ];
      
      const result = isPluginEntitled('test-plugin', keys);
      expect(result.entitled).toBe(true);
      expect(result.keyInfo).toBeDefined();
    });

    it('should return not entitled for plugin without key', () => {
      const keys: any[] = [];
      const result = isPluginEntitled('nonexistent-plugin', keys);
      expect(result.entitled).toBe(false);
    });

    it('should return not entitled for plugin with expired key', () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0].replace(/-/g, '');
      
      const keys = [
        {
          key: `PC-test-plugin-${yesterdayStr}-ABC123`,
          pluginId: 'test-plugin',
          issuedAt: new Date().toISOString(),
          expiresAt: null,
          status: 'valid' as const
        }
      ];
      
      const result = isPluginEntitled('test-plugin', keys);
      expect(result.entitled).toBe(false);
    });
  });

  describe('addPluginEntitlementKey', () => {
    it('should add a new plugin entitlement key', () => {
      const initialKeys = [];
      const newKeys = addPluginEntitlementKey(initialKeys, 'PC-new-plugin-20251231-NEW123', 'new-plugin');
      
      expect(newKeys).toHaveLength(1);
      expect(newKeys[0]).toEqual({
        key: 'PC-new-plugin-20251231-NEW123',
        pluginId: 'new-plugin',
        issuedAt: expect.any(String),
        expiresAt: expect.any(String),
        status: 'valid'
      });
    });

    it('should replace existing key for same plugin', () => {
      const initialKeys = [
        {
          key: 'PC-existing-plugin-20241231-OLD123',
          pluginId: 'existing-plugin',
          issuedAt: new Date().toISOString(),
          expiresAt: null,
          status: 'valid' as const
        }
      ];
      
      const newKeys = addPluginEntitlementKey(initialKeys, 'PC-existing-plugin-20251231-NEW123', 'existing-plugin');
      
      expect(newKeys).toHaveLength(1);
      expect(newKeys[0].key).toBe('PC-existing-plugin-20251231-NEW123');
    });
  });

  describe('removePluginEntitlementKey', () => {
    it('should remove key for specified plugin', () => {
      const initialKeys = [
        {
          key: 'PC-plugin1-20251231-KEY1',
          pluginId: 'plugin1',
          issuedAt: new Date().toISOString(),
          expiresAt: null,
          status: 'valid' as const
        },
        {
          key: 'PC-plugin2-20251231-KEY2',
          pluginId: 'plugin2',
          issuedAt: new Date().toISOString(),
          expiresAt: null,
          status: 'valid' as const
        }
      ];
      
      const newKeys = removePluginEntitlementKey(initialKeys, 'plugin1');
      expect(newKeys).toHaveLength(1);
      expect(newKeys[0].pluginId).toBe('plugin2');
    });

    it('should not change keys if plugin not found', () => {
      const initialKeys = [
        {
          key: 'PC-plugin1-20251231-KEY1',
          pluginId: 'plugin1',
          issuedAt: new Date().toISOString(),
          expiresAt: null,
          status: 'valid' as const
        }
      ];
      
      const newKeys = removePluginEntitlementKey(initialKeys, 'nonexistent-plugin');
      expect(newKeys).toHaveLength(1);
      expect(newKeys[0].pluginId).toBe('plugin1');
    });
  });
});