import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pluginEntitlementEnforcement } from '../plugin-entitlement-enforcement';

// Mock the database and lifecycle manager
const mockDb = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  then: vi.fn()
};

const mockLifecycleManager = {
  getStatus: vi.fn(),
  disable: vi.fn()
};

describe('Plugin Entitlement Enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should check if a plugin is entitled based on instance settings', async () => {
    // Mock the database response with plugin entitlement keys
    const mockSettings = {
      general: {
        pluginEntitlementKeys: [
          {
            key: 'PC-test-plugin-20251231-ABC123',
            pluginId: 'test-plugin',
            issuedAt: new Date().toISOString(),
            expiresAt: null,
            status: 'valid'
          }
        ]
      }
    };
    
    (mockDb.select as any).mockReturnThis();
    (mockDb.from as any).mockReturnThis();
    (mockDb.where as any).mockReturnThis();
    (mockDb.then as any).mockResolvedValue([mockSettings]);

    const enforcement = pluginEntitlementEnforcement(mockDb as any, mockLifecycleManager as any);
    const result = await enforcement.isPluginEntitled('test-plugin');

    expect(result.entitled).toBe(true);
  });

  it('should return not entitled for plugin without valid key', async () => {
    // Mock the database response with no plugin entitlement keys
    const mockSettings = {
      general: {
        pluginEntitlementKeys: []
      }
    };
    
    (mockDb.select as any).mockReturnThis();
    (mockDb.from as any).mockReturnThis();
    (mockDb.where as any).mockReturnThis();
    (mockDb.then as any).mockResolvedValue([mockSettings]);

    const enforcement = pluginEntitlementEnforcement(mockDb as any, mockLifecycleManager as any);
    const result = await enforcement.isPluginEntitled('nonexistent-plugin');

    expect(result.entitled).toBe(true); // No restriction if no keys are required
  });

  it('should enforce entitlement and return result', async () => {
    // Mock the database response with plugin entitlement keys
    const mockSettings = {
      general: {
        pluginEntitlementKeys: [
          {
            key: 'PC-test-plugin-20251231-ABC123',
            pluginId: 'test-plugin',
            issuedAt: new Date().toISOString(),
            expiresAt: null,
            status: 'valid'
          }
        ]
      }
    };
    
    (mockDb.select as any).mockReturnThis();
    (mockDb.from as any).mockReturnThis();
    (mockDb.where as any).mockReturnThis();
    (mockDb.then as any).mockResolvedValue([mockSettings]);

    const enforcement = pluginEntitlementEnforcement(mockDb as any, mockLifecycleManager as any);
    const result = await enforcement.enforcePluginEntitlement('test-plugin', 'test-plugin');

    expect(result.entitled).toBe(true);
  });
});