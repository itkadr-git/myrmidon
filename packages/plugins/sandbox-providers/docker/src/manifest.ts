import type { PaperclipPluginManifestV1 } from "@myrmidon/plugin-sdk";

const PLUGIN_ID = "paperclip.docker-sandbox-provider";
const PLUGIN_VERSION = "0.0.1";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Docker Sandbox Provider",
  description:
    "First-party sandbox provider plugin that provisions Docker containers via dockergate as Paperclip execution environments.",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["environment.drivers.register"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  environmentDrivers: [
    {
      driverKey: "docker",
      kind: "sandbox_provider",
      displayName: "Docker (own server via dockergate)",
      description:
        "Provisions Docker container sandboxes via dockergate.",
      configSchema: {
        type: "object",
        properties: {},
      },
    },
  ],
};

export default manifest;
