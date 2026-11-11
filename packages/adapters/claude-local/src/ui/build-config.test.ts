import { describe, expect, it } from "vitest";
import type { CreateConfigValues } from "@myrmidon/adapter-utils";
import { buildClaudeLocalConfig } from "./build-config.js";

function makeValues(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "claude_local",
    cwd: "",
    instructionsFilePath: "",
    promptTemplate: "",
    model: "claude-opus-4-7",
    thinkingEffort: "",
    chrome: false,
    dangerouslySkipPermissions: true,
    claudeEngine: "auto",
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
    payloadTemplateJson: "",
    workspaceStrategyType: "project_primary",
    workspaceBaseRef: "",
    workspaceBranchTemplate: "",
    worktreeParentDir: "",
    runtimeServicesJson: "",
    maxTurnsPerRun: 1000,
    heartbeatEnabled: false,
    intervalSec: 300,
    ...overrides,
  };
}

describe("buildClaudeLocalConfig", () => {
  it("omits engine for the auto default so runtime fallback remains available", () => {
    const config = buildClaudeLocalConfig(makeValues({ claudeEngine: "auto" }));

    expect(config).not.toHaveProperty("engine");
  });

  it("persists explicit engine pins", () => {
    expect(buildClaudeLocalConfig(makeValues({ claudeEngine: "cli" }))).toMatchObject({ engine: "cli" });
    expect(buildClaudeLocalConfig(makeValues({ claudeEngine: "acp" }))).toMatchObject({ engine: "acp" });
  });

  it("keeps user-scoped env bindings so the server resolves them at test time", () => {
    const config = buildClaudeLocalConfig(
      makeValues({
        envBindings: {
          GH_TOKEN: { type: "user_secret_ref", key: "github_token", version: "latest", required: true },
        },
      }),
    );

    expect(config.env).toEqual({
      GH_TOKEN: { type: "user_secret_ref", key: "github_token", version: "latest", required: true },
    });
  });

  it("keeps company secret and plain env bindings", () => {
    const config = buildClaudeLocalConfig(
      makeValues({
        envBindings: {
          API_KEY: { type: "secret_ref", secretId: "11111111-1111-1111-1111-111111111111", version: "latest" },
          FLAG: { type: "plain", value: "on" },
        },
      }),
    );

    expect(config.env).toEqual({
      API_KEY: { type: "secret_ref", secretId: "11111111-1111-1111-1111-111111111111", version: "latest" },
      FLAG: { type: "plain", value: "on" },
    });
  });

  it("persists the sandbox and timeout fields the settings form writes", () => {
    const config = buildClaudeLocalConfig(
      makeValues({
        adapterSchemaValues: {
          filesystemScope: "workspace",
          filesystemExtraPaths: ["/tmp/extra", { path: "/tmp/data", access: "rw" }],
          networkScope: "allowlist",
          networkAllowlist: ["api.anthropic.com"],
          helloProbeTimeoutSec: 90,
          terminalResultCleanupGraceMs: 8000,
        },
      }),
    );
    expect(config).toMatchObject({
      filesystemScope: "workspace",
      filesystemExtraPaths: ["/tmp/extra", { path: "/tmp/data", access: "rw" }],
      networkScope: "allowlist",
      networkAllowlist: ["api.anthropic.com"],
      helloProbeTimeoutSec: 90,
      terminalResultCleanupGraceMs: 8000,
    });
  });

  it("leaves unset sandbox fields out and ignores keys no adapter reads", () => {
    const config = buildClaudeLocalConfig(
      makeValues({
        adapterSchemaValues: {
          filesystemExtraPaths: [],
          networkAllowlist: [],
          helloProbeTimeoutSec: 0,
          probe: true,
          approvalMode: "bypass",
          timeoutSec: 99,
        },
      }),
    );
    for (const key of [
      "filesystemScope",
      "filesystemExtraPaths",
      "networkScope",
      "networkAllowlist",
      "helloProbeTimeoutSec",
      "probe",
      "approvalMode",
    ]) {
      expect(config).not.toHaveProperty(key);
    }
    expect(config.timeoutSec).toBe(0);
    expect(config.graceSec).toBe(15);
  });
});
