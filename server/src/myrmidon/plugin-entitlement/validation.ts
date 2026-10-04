/**
 * myrmidon(PLUGIN-ENTITLEMENT C): Plugin Entitlement Key Validation
 * 
 * This module provides functionality to validate plugin entitlement keys
 * and manage plugin activation based on valid keys.
 */

import type { PluginEntitlementKey, PluginEntitlementKeys } from "@paperclipai/shared";

/**
 * Validates a plugin entitlement key against some criteria.
 * In a real implementation, this would likely involve checking against
 * a remote licensing service or validating cryptographic signatures.
 */
export function validatePluginEntitlementKey(key: string, pluginId: string): { isValid: boolean; expiresAt: Date | null } {
  // In a real implementation, this would validate the key properly
  // For now, we'll implement a simple validation mechanism for demonstration
  
  // Format: PC-{PLUGIN_ID}-{DATE_EXPIRES}-{CHECKSUM}
  // For demo purposes, we'll recognize keys that start with PC- and contain the plugin ID
  if (key.startsWith('PC-') && key.includes(pluginId.replace(/\./g, '_'))) {
    // Extract expiry date from the key if possible
    // Format example: PC-plugin_id-20251231-ABC123
    const parts = key.split('-');
    if (parts.length >= 3) {
      const datePart = parts[2];
      if (/^\d{8}$/.test(datePart)) {
        // Parse YYYYMMDD format
        const year = parseInt(datePart.substring(0, 4));
        const month = parseInt(datePart.substring(4, 6)) - 1; // JS months are 0-indexed
        const day = parseInt(datePart.substring(6, 8));
        
        const expiryDate = new Date(year, month, day);
        const now = new Date();
        
        // Return validity based on expiry date
        return {
          isValid: expiryDate >= now,
          expiresAt: expiryDate
        };
      }
    }
    
    // If no expiry date in key, consider it valid indefinitely for demo purposes
    return {
      isValid: true,
      expiresAt: null
    };
  }
  
  // Invalid key format
  return {
    isValid: false,
    expiresAt: null
  };
}

/**
 * Checks if a plugin has a valid entitlement key
 */
export function isPluginEntitled(pluginId: string, keys: PluginEntitlementKeys): { entitled: boolean; keyInfo?: PluginEntitlementKey } {
  for (const keyInfo of keys) {
    if (keyInfo.pluginId === pluginId) {
      // Validate the key
      const validation = validatePluginEntitlementKey(keyInfo.key, pluginId);
      
      if (validation.isValid) {
        return {
          entitled: true,
          keyInfo: {
            ...keyInfo,
            status: 'valid',
            expiresAt: validation.expiresAt?.toISOString() || null
          }
        };
      } else {
        // Update status to expired/invalid
        keyInfo.status = validation.expiresAt ? 'expired' : 'invalid';
        return {
          entitled: false,
          keyInfo
        };
      }
    }
  }
  
  // No key found for this plugin
  return {
    entitled: false
  };
}

/**
 * Adds a new plugin entitlement key
 */
export function addPluginEntitlementKey(keys: PluginEntitlementKeys, key: string, pluginId: string): PluginEntitlementKeys {
  // Check if key already exists
  const existingIndex = keys.findIndex(k => k.pluginId === pluginId);
  
  if (existingIndex !== -1) {
    // Replace existing key for this plugin
    keys.splice(existingIndex, 1);
  }
  
  const validation = validatePluginEntitlementKey(key, pluginId);
  
  const newKey: PluginEntitlementKey = {
    key,
    pluginId,
    issuedAt: new Date().toISOString(),
    expiresAt: validation.expiresAt?.toISOString() || null,
    status: validation.isValid ? 'valid' : (validation.expiresAt ? 'expired' : 'invalid')
  };
  
  return [...keys, newKey];
}

/**
 * Removes a plugin entitlement key
 */
export function removePluginEntitlementKey(keys: PluginEntitlementKeys, pluginId: string): PluginEntitlementKeys {
  return keys.filter(key => key.pluginId !== pluginId);
}