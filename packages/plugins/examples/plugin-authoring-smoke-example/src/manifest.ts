import type { PaperclipPluginManifestV1 } from "@myrmidon/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclipai.plugin-authoring-smoke-example",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Plugin Authoring Smoke Example",
  description: "A Paperclip plugin",
  author: "Plugin Author",
  categories: ["connector"],
  providerModels: {
    provider: "example-provider",
    baseUrl: "https://api.example.com/v1",
    credentialSecretName: "example-provider-key",
    models: [{ id: "example-model", name: "Example Model" }],
  },
  capabilities: [
    "events.subscribe",
    "plugin.state.read",
    "plugin.state.write",
    "ui.dashboardWidget.register"
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui"
  },
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "health-widget",
        displayName: "Plugin Authoring Smoke Example Health",
        exportName: "DashboardWidget"
      }
    ]
  }
};

export default manifest;
