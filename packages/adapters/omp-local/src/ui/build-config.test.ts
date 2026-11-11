import { describe, expect, it } from "vitest";
import { buildOmpLocalConfig } from "./build-config.js";
import type { CreateConfigValues } from "@myrmidon/adapter-utils";

function makeValues(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "omp_local",
    cwd: "",
    instructionsFilePath: "",
    promptTemplate: "",
    model: "xai/grok-4",
    thinkingEffort: "",
    chrome: false,
    dangerouslySkipPermissions: true,
    search: false,
    fastMode: false,
    dangerouslyBypassSandbox: true,
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

describe("buildOmpLocalConfig", () => {
  it("defaults filesystemScope to workspace and persists sandbox fields from schema values", () => {
    const config = buildOmpLocalConfig(makeValues({
      adapterSchemaValues: {
        filesystemScope: "workspace",
        filesystemExtraPaths: ["/tmp/extra"],
        networkScope: "allowlist",
        networkAllowlist: ["api.xai.com"],
      },
    }));
    expect(config).toMatchObject({
      filesystemScope: "workspace",
      filesystemExtraPaths: ["/tmp/extra"],
      networkScope: "allowlist",
      networkAllowlist: ["api.xai.com"],
      model: "xai/grok-4",
    });
  });

  // myrmidon(1.6.7 OPE-12266): an explicit "off" in the create form wins over the
  // default — the server-side create default only fills a missing filesystemScope.
  it("honors an explicit filesystemScope=off from the create form", () => {
    const config = buildOmpLocalConfig(makeValues({
      adapterSchemaValues: { filesystemScope: "off" },
    }));
    expect(config.filesystemScope).toBe("off");
  });
});
