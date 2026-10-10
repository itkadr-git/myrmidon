// myrmidon(PLUGIN-ENTITLEMENT C / 1.6.3 A): the instance-admin surface of the
// plugin entitlement settings:
//   GET/POST/DELETE /api/myrmidon/plugin-entitlement/keys
//   GET/PUT         /api/myrmidon/plugin-entitlement/public-key
// The keys list never carries key values (the server strips them); accepting a
// key and rotating the verification public key take effect without a restart
// (the loader gate re-reads the settings row on every activation pass).
import type { PluginEntitlementKeyView, PluginEntitlementPublicKeyView } from "@paperclipai/shared";
import { api } from "@/api/client";

export const pluginEntitlementQueryKey = ["myrmidon", "plugin-entitlement", "keys"] as const;
export const pluginEntitlementPublicKeyQueryKey = [
  "myrmidon",
  "plugin-entitlement",
  "public-key",
] as const;

export const pluginEntitlementApi = {
  list: () => api.get<PluginEntitlementKeyView[]>("/myrmidon/plugin-entitlement/keys"),
  accept: (input: { pluginId: string; key: string }) =>
    api.post<PluginEntitlementKeyView[]>("/myrmidon/plugin-entitlement/keys", input),
  remove: (pluginId: string) =>
    api.delete<PluginEntitlementKeyView[]>(`/myrmidon/plugin-entitlement/keys/${encodeURIComponent(pluginId)}`),
  getPublicKey: () =>
    api.get<PluginEntitlementPublicKeyView>("/myrmidon/plugin-entitlement/public-key"),
  setPublicKey: (publicKey: string | null) =>
    api.put<PluginEntitlementPublicKeyView>("/myrmidon/plugin-entitlement/public-key", { publicKey }),
};