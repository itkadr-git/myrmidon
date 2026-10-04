// myrmidon(PLUGIN-ENTITLEMENT C): GET/POST/DELETE /api/myrmidon/plugin-entitlement/keys.
// Instance-admin surface for the plugin entitlement keys stored in the
// instance general settings. Accepting a key takes effect without a restart
// (the loader gate re-reads the row on every activation pass).
import type { PluginEntitlementKey } from "@paperclipai/shared";
import { api } from "@/api/client";

export const pluginEntitlementQueryKey = ["myrmidon", "plugin-entitlement", "keys"] as const;

export const pluginEntitlementApi = {
  list: () => api.get<PluginEntitlementKey[]>("/myrmidon/plugin-entitlement/keys"),
  accept: (input: { pluginId: string; key: string }) =>
    api.post<PluginEntitlementKey[]>("/myrmidon/plugin-entitlement/keys", input),
  remove: (pluginId: string) =>
    api.delete<PluginEntitlementKey[]>(`/myrmidon/plugin-entitlement/keys/${encodeURIComponent(pluginId)}`),
};
