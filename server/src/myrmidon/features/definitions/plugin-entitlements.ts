// myrmidon(FEATURES): plugin entitlement keys (a plugin that requires an
// entitlement stays unactivated until the instance admin accepts a key).
//
// There is no runtime loop here. Health is the validity of the stored keys: an
// expired key silently locks its plugin again, which is what this entry shows.

import {
  PLUGIN_ENTITLEMENT_KEYS_SETTINGS_KEY,
  isPluginEntitlementKeyActive,
  normalizePluginEntitlementKeys,
} from "@paperclipai/shared";
import { entry, healthOff, makeHealth } from "../health.js";
import type { FeatureDefinition } from "../types.js";

export const PLUGIN_ENTITLEMENTS_FEATURE_KEY = "plugin-entitlements";

export const pluginEntitlementsFeature: FeatureDefinition = {
  key: PLUGIN_ENTITLEMENTS_FEATURE_KEY,
  name: "Plugin entitlements",
  description:
    "Plugins whose manifest requires an entitlement stay unactivated until a valid key for that plugin is accepted in the instance settings.",
  docs: "docs/myrmidon/guides/plugin-entitlement-keys.md",
  settings: { path: "/company/settings", panel: "Plugin Entitlement Keys" },

  readConfig(ctx) {
    const keys = normalizePluginEntitlementKeys(ctx.general[PLUGIN_ENTITLEMENT_KEYS_SETTINGS_KEY]);
    const active = keys.filter((key) => isPluginEntitlementKeyActive(key, ctx.now));
    return {
      enabled: keys.length > 0,
      entries: [
        // Key values never leave the server; only counts and plugin ids are shown.
        entry("Accepted keys", keys.length, "settings"),
        entry("Active keys", active.length, "derived"),
        entry(
          "Plugins with an expired key",
          keys.filter((key) => !isPluginEntitlementKeyActive(key, ctx.now)).map((key) => key.pluginId).join(", ") || "none",
          "derived",
        ),
      ],
    };
  },

  health(ctx, config) {
    if (!config.enabled) return healthOff("no entitlement key is accepted");
    const keys = normalizePluginEntitlementKeys(ctx.general[PLUGIN_ENTITLEMENT_KEYS_SETTINGS_KEY]);
    const expired = keys.filter((key) => !isPluginEntitlementKeyActive(key, ctx.now));
    const active = keys.length - expired.length;
    const base = { effect: { label: "plugins entitled by an active key", value: active } };
    if (expired.length > 0) {
      return makeHealth(
        "misconfigured",
        `${expired.length} entitlement key(s) expired (${expired.map((key) => key.pluginId).join(", ")}); those plugins are locked again`,
        base,
      );
    }
    return makeHealth("working", `${active} plugin(s) entitled by an unexpired key`, base);
  },
};
