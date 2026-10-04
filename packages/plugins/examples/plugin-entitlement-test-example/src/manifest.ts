import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip.entitlement-test";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Entitlement Test Plugin",
  description: "Test plugin that requires an entitlement key to be enabled.",
  author: "Paperclip",
  categories: ["testing", "utilities"],
  requiresEntitlement: true, // This indicates the plugin needs an entitlement key
  capabilities: [
    "ui.sidebar.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      {
        type: "sidebar",
        id: "entitlement-test-sidebar",
        displayName: "Entitlement Test",
        exportName: "EntitlementTestSidebar",
        order: 10,
      },
    ],
  },
};

export default manifest;