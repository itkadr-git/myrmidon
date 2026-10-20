import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

/** Reference provider manifest used by plugin integration tests and authors. */
const manifest: PaperclipPluginManifestV1 = {
  id: "paperclipai.provider.chatgpt-pool",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "ChatGPT Pool Provider",
  description: "ChatGPT pool models exposed through the configured gateway.",
  author: "Paperclip",
  categories: ["connector"],
  providerModels: {
    provider: "chatgpt-pool",
    baseUrl: "https://api.openai.com/v1",
    credentialSecretName: "chatgpt-pool-api-key",
    models: [
      { id: "gpt-4o", name: "GPT-4o" },
      { id: "gpt-4o-mini", name: "GPT-4o mini" },
    ],
  },
  entrypoints: { worker: "./dist/worker.js" },
};

export default manifest;
