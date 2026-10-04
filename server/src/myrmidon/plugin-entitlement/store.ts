/**
 * myrmidon(PLUGIN-ENTITLEMENT C): Plugin Entitlement Keys preservation
 * 
 * This module preserves plugin entitlement key information across vendor writes
 * of the general settings, ensuring that plugin keys remain intact when other
 * settings are updated.
 */

import type { InstanceGeneralSettings } from "@paperclipai/shared";

export function preservePluginEntitlementKeysGeneralKey(
  currentGeneral: InstanceGeneralSettings,
): Partial<InstanceGeneralSettings> {
  // Preserve the plugin entitlement keys during general settings updates
  if (currentGeneral.pluginEntitlementKeys) {
    return {
      pluginEntitlementKeys: currentGeneral.pluginEntitlementKeys,
    };
  }
  
  // Return empty object if no plugin entitlement keys exist
  return {};
}