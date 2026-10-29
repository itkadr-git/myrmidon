import { describe, expect, it } from "vitest";
import { buildAgentMemoryPatch } from "./AgentMemorySettingsPanel";

describe("buildAgentMemoryPatch", () => {
  it("clears empty fields so the environment applies", () => {
    expect(
      buildAgentMemoryPatch({
        enabled: true,
        apiUrl: " ",
        keySecretName: "",
        accessMode: "all",
        enabledRoles: [],
        enabledAgentIds: [],
      }),
    ).toEqual({
      patch: {
        enabled: null,
        apiUrl: null,
        keySecretName: null,
        accessMode: "all",
        enabledRoles: null,
        enabledAgentIds: null,
      },
      urlError: null,
    });
  });

  it("stores an address, a key secret name and an explicit off switch", () => {
    expect(
      buildAgentMemoryPatch({
        enabled: false,
        apiUrl: "http://memory.invalid",
        keySecretName: " k ",
        accessMode: "roles",
        enabledRoles: ["engineer", "lead"],
        enabledAgentIds: [],
      }).patch,
    ).toEqual({
      enabled: false,
      apiUrl: "http://memory.invalid",
      keySecretName: "k",
      accessMode: "roles",
      enabledRoles: ["engineer", "lead"],
      enabledAgentIds: null,
    });
  });

  it("stores selected agents when in selected mode", () => {
    expect(
      buildAgentMemoryPatch({
        enabled: true,
        apiUrl: "http://memory.invalid",
        keySecretName: "",
        accessMode: "selected",
        enabledRoles: [],
        enabledAgentIds: ["agent-1", "agent-2"],
      }).patch,
    ).toEqual({
      enabled: null,
      apiUrl: "http://memory.invalid",
      keySecretName: null,
      accessMode: "selected",
      enabledRoles: null,
      enabledAgentIds: ["agent-1", "agent-2"],
    });
  });

  it("rejects a non-http address", () => {
    const built = buildAgentMemoryPatch({
      enabled: true,
      apiUrl: "ftp://x",
      keySecretName: "",
      accessMode: "all",
      enabledRoles: [],
      enabledAgentIds: [],
    });
    expect(built.patch).toBeNull();
    expect(built.urlError).not.toBeNull();
  });
});