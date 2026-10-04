/**
 * myrmidon(PLUGIN-ENTITLEMENT C): Plugin Entitlement Enforcement
 * 
 * This module integrates plugin entitlement validation with the plugin lifecycle
 * to enforce license key requirements for plugin activation.
 */

import type { PluginLifecycleManager } from "../services/plugin-lifecycle.js";
import type { Db } from "@paperclipai/db";
import { instanceSettings } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import type { PluginRecord } from "@paperclipai/shared";
import { validatePluginEntitlementKey, isPluginEntitled } from "../myrmidon/plugin-entitlement/validation.js";

const DEFAULT_SINGLETON_KEY = "default";

export interface PluginEntitlementEnforcement {
  /**
   * Check if a plugin is entitled to run based on its license key
   */
  isPluginEntitled(pluginId: string): Promise<{ entitled: boolean; reason?: string }>;
  
  /**
   * Enforce entitlement for a plugin - prevent activation if no valid key
   */
  enforcePluginEntitlement(pluginId: string, pluginKey: string): Promise<{ entitled: boolean; reason?: string }>;
}

export function pluginEntitlementEnforcement(
  db: Db,
  lifecycleManager: PluginLifecycleManager
): PluginEntitlementEnforcement {
  return {
    async isPluginEntitled(pluginId: string): Promise<{ entitled: boolean; reason?: string }> {
      // Get instance settings to check for plugin entitlement keys
      const instanceSettingsRows = await db
        .select()
        .from(instanceSettings)
        .where(eq(instanceSettings.singletonKey, DEFAULT_SINGLETON_KEY));
      
      if (instanceSettingsRows.length === 0) {
        return { entitled: true }; // No settings means no restrictions
      }
      
      const settings = instanceSettingsRows[0];
      const pluginKeys = settings.general?.pluginEntitlementKeys || [];
      
      // Check if this plugin requires entitlement
      // For now, we'll determine this by checking if it has a key requirement in its manifest
      // In a real implementation, we'd load the manifest to check for requiresEntitlement field
      
      const result = isPluginEntitled(pluginId, pluginKeys);
      
      if (result.entitled) {
        return { entitled: true };
      } else {
        if (result.keyInfo) {
          if (result.keyInfo.status === 'expired') {
            return { entitled: false, reason: 'license_expired' };
          } else if (result.keyInfo.status === 'invalid') {
            return { entitled: false, reason: 'license_invalid' };
          }
        }
        return { entitled: false, reason: 'license_required' };
      }
    },
    
    async enforcePluginEntitlement(pluginId: string, pluginKey: string): Promise<{ entitled: boolean; reason?: string }> {
      const entitlementCheck = await this.isPluginEntitled(pluginId);
      
      if (!entitlementCheck.entitled) {
        // Attempt to disable the plugin if it's currently active
        const currentStatus = await lifecycleManager.getStatus(pluginId);
        if (currentStatus === 'ready') {
          try {
            await lifecycleManager.disable(
              pluginId, 
              entitlementCheck.reason === 'license_expired' 
                ? 'Plugin license has expired' 
                : entitlementCheck.reason === 'license_invalid'
                  ? 'Plugin license is invalid'
                  : 'Plugin license is required but not provided'
            );
          } catch (error) {
            console.error(`Failed to disable unentitled plugin ${pluginId}:`, error);
          }
        }
        return entitlementCheck;
      }
      
      return { entitled: true };
    }
  };
}