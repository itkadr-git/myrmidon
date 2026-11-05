import { describe, expect, it } from "vitest";
import type { CreateConfigValues } from "@myrmidon/adapter-utils";
import { buildHermesConfig } from "./build-config.js";

const base = (): CreateConfigValues => ({
  adapterType: "hermes_local",
  cwd: "",
  promptTemplate: "",
  model: "",
  thinkingEffort: "",
  chrome: false,
  dangerouslySkipPermissions: false,
  search: false,
  fastMode: false,
  dangerouslyBypassSandbox: false,
  command: "",
  args: "",
  extraArgs: "",
  envVars: "",
  envBindings: {},
  url: "",
  bootstrapPrompt: "",
  maxTurnsPerRun: 0,
  heartbeatEnabled: true,
  intervalSec: 60,
});

describe("Hermes local create config", () => {
  it("persists schema-backed toolsets and sandbox settings", () => {
    const config = buildHermesConfig({
      ...base(),
      adapterSchemaValues: {
        toolsets: "terminal,file",
        filesystemScope: "workspace",
        networkScope: "deny",
        includeConfiguredMcpServers: false,
        runtimeMcpUrlRewrite: false,
        runtimeMcpUrlBase: "http://127.0.0.1:3100",
        timeoutSec: 900,
        persistSession: false,
      },
    });
    expect(config).toMatchObject({
      toolsets: "terminal,file",
      filesystemScope: "workspace",
      networkScope: "deny",
      includeConfiguredMcpServers: false,
      runtimeMcpUrlRewrite: false,
      runtimeMcpUrlBase: "http://127.0.0.1:3100",
      timeoutSec: 900,
      persistSession: false,
    });
  });

  it("does not copy arbitrary or duplicate input-limit keys", () => {
    const config = buildHermesConfig({
      ...base(),
      adapterSchemaValues: { inputLimitTokens: 42, unrelated: "ignored", timeoutSec: -1 },
    });
    expect(config).not.toHaveProperty("inputLimitTokens");
    expect(config).not.toHaveProperty("unrelated");
    expect(config.timeoutSec).toBeGreaterThan(0);
  });
});
