import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

/** Reference manifest for a company-scoped Google AI/Gemini plugin provider. */
const manifest: PaperclipPluginManifestV1 = {
  id: "paperclipai.provider.google-gemini",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Google AI Gemini Provider",
  description: "Gemini models exposed through the configured gateway.",
  author: "Paperclip",
  categories: ["connector"],
  providerModels: {
    provider: "google-ai-gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    credentialSecretName: "google-ai-api-key",
    models: [
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    ],
  },
  entrypoints: { worker: "./dist/worker.js" },
};

export default manifest;
