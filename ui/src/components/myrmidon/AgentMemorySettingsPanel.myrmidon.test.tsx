import { describe, expect, it } from "vitest";
import { buildAgentMemoryPatch } from "./AgentMemorySettingsPanel";

describe("buildAgentMemoryPatch", () => {
  it("clears empty fields so the environment applies", () => {
    expect(buildAgentMemoryPatch({ enabled: true, apiUrl: " ", keySecretName: "" })).toEqual({
      patch: { enabled: null, apiUrl: null, keySecretName: null },
      urlError: null,
    });
  });

  it("stores an address, a key secret name and an explicit off switch", () => {
    expect(buildAgentMemoryPatch({ enabled: false, apiUrl: "http://memory.invalid", keySecretName: " k " }).patch).toEqual({
      enabled: false,
      apiUrl: "http://memory.invalid",
      keySecretName: "k",
    });
  });

  it("rejects a non-http address", () => {
    const built = buildAgentMemoryPatch({ enabled: true, apiUrl: "ftp://x", keySecretName: "" });
    expect(built.patch).toBeNull();
    expect(built.urlError).not.toBeNull();
  });
});
