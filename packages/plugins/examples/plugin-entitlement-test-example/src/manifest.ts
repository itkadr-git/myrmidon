// Example plugin (myrmidon PLUGIN-ENTITLEMENT C): a minimal manifest that
// opts into entitlement gating. With `requiresEntitlement: true` the loader
// keeps this plugin unactivated (no worker, no UI slots, hidden from menus)
// until the instance admin accepts an entitlement key for exactly this id.
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

const manifest: PaperclipPluginManifestV1 = {
  id: "example.entitlement-gated",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Entitlement Gated Example",
  description: "Example plugin that stays inactive until an entitlement key is accepted",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["plugin.state.read"],
  entrypoints: { worker: "./dist/worker.js" },
  // myrmidon(PLUGIN-ENTITLEMENT C): the gate flag.
  requiresEntitlement: true,
};

export default manifest;
