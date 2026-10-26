import type { PaperclipPluginManifestV1 } from "@myrmidon/plugin-sdk";

export const PLUGIN_ID = "paperclip.plugin-stt-gigaam";
export const PLUGIN_VERSION = "0.1.0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "GigaAM Speech Recognition",
  description: "Reports readiness, model and VAD loading, fallback mode, transcription totals and p50 latency for the GigaAM STT service.",
  author: "Paperclip",
  categories: ["monitoring"],
  capabilities: ["http.outbound", "secrets.read-ref"],
  entrypoints: { worker: "./dist/worker.js" },
  instanceConfigSchema: {
    type: "object",
    required: ["baseUrl"],
    properties: {
      baseUrl: {
        type: "string",
        title: "STT service URL",
        description: "HTTPS service URL, or HTTP on loopback for local development.",
      },
      authTokenRef: {
        type: "object",
        title: "STT bearer token (secret ref)",
        description: "Optional secret reference for the service Authorization bearer token.",
        properties: {
          type: { type: "string", enum: ["secret_ref"] },
          secretId: { type: "string" },
          version: { type: "number" },
        },
        required: ["type", "secretId"],
      },
    },
  },
};

export default manifest;
