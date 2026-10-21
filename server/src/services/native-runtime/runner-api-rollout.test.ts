import { describe, expect, it } from "vitest";
import { readProductEnv } from "@paperclipai/shared/env-alias"; // myrmidon(REBRAND-C)
import { runnerApiToolsEnabled } from "./runner-api-rollout.js";

describe("runner API rollout", () => {
  it("requires operator opt-in and fails closed for invalid settings", () => {
    for (const value of [undefined, "", "TRUE", "1", "invalid"]) {
      for (const binding of [undefined, false, true]) expect(runnerApiToolsEnabled("company", binding, { PAPERCLIP_RUNNER_API_TOOLS_ENABLED: value })).toBe(false);
    }
    expect(runnerApiToolsEnabled("company", undefined, { PAPERCLIP_RUNNER_API_TOOLS_ENABLED: "true" })).toBe(true);
  });
  it("restricts an enabled rollout to exact company IDs", () => {
    const env = {
      PAPERCLIP_RUNNER_API_TOOLS_ENABLED: "true",
      PAPERCLIP_RUNNER_API_TOOLS_COMPANY_IDS: " alpha, beta ",
    };
    expect(runnerApiToolsEnabled("alpha", undefined, env)).toBe(true);
    expect(runnerApiToolsEnabled("alph", undefined, env)).toBe(false);
    expect(runnerApiToolsEnabled("foreign", true, env)).toBe(false);
    expect(runnerApiToolsEnabled("alpha", undefined, { ...env, PAPERCLIP_RUNNER_API_TOOLS_COMPANY_IDS: "" })).toBe(false);
  });
  it("prefers canonical rollout policy and falls back to legacy aliases", () => {
    const read = (env: Record<string, string | undefined>, name: string) => readProductEnv(name, { env, warn: () => {} });
    expect(read({ PAPERCLIP_RUNNER_API_TOOLS_ENABLED: "true" }, "RUNNER_API_TOOLS_ENABLED")).toBe("true");
    expect(read({ PAPERCLIP_RUNNER_API_TOOLS_ENABLED: "true", MYRMIDON_RUNNER_API_TOOLS_ENABLED: "" }, "RUNNER_API_TOOLS_ENABLED")).toBe("");
    expect(read({}, "RUNNER_API_TOOLS_ENABLED")).toBeUndefined();
    const legacy = {
      PAPERCLIP_RUNNER_API_TOOLS_ENABLED: "true",
      PAPERCLIP_RUNNER_API_TOOLS_COMPANY_IDS: "alpha",
    };
    expect(runnerApiToolsEnabled("alpha", undefined, legacy)).toBe(true);
    expect(runnerApiToolsEnabled("company", undefined, {
      ...legacy,
      MYRMIDON_RUNNER_API_TOOLS_ENABLED: "",
    })).toBe(false);
    expect(runnerApiToolsEnabled("beta", undefined, {
      ...legacy,
      MYRMIDON_RUNNER_API_TOOLS_COMPANY_IDS: "beta",
    })).toBe(true);
  });

  it("keeps baseline tools disabled and honors an operator stop over explicit bindings", () => {
    expect(runnerApiToolsEnabled("company", false, { PAPERCLIP_RUNNER_API_TOOLS_ENABLED: "true" })).toBe(false);
    expect(runnerApiToolsEnabled("company", true, {})).toBe(false);
    expect(runnerApiToolsEnabled("company", true, { PAPERCLIP_RUNNER_API_TOOLS_ENABLED: "false" })).toBe(false);
  });
});
