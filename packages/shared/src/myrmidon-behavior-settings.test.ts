import { describe, expect, it } from "vitest";
import { behaviorSettingRegistry, resolveSetting } from "./myrmidon-behavior-settings.js";

describe("resolveSetting", () => {
  it("prioritizes valid environment override over stored value", () => {
    expect(resolveSetting<number>({
      key: "tool_breaker_failures",
      stored: 0,
      env: { MYRMIDON_TOOL_BREAKER_FAILURES: "3" },
    })).toEqual({ value: 3, source: "env" });
  });

  it("uses saved setting when the environment is absent", () => {
    expect(resolveSetting<number>({ key: "tool_breaker_failures", stored: 0, env: {} }))
      .toEqual({ value: 0, source: "ui" });
  });

  it("uses the default if neither environment nor saved value is valid", () => {
    expect(resolveSetting<number>({ key: "tool_breaker_failures", stored: "bad", env: {} }))
      .toEqual({ value: 3, source: "default" });
  });

  it("lists instance-scoped settings only", () => {
    expect(behaviorSettingRegistry.getInstanceKeys()).toContain("tool_breaker_failures");
    expect(behaviorSettingRegistry.getInstanceKeys()).not.toContain("hypothetical_company_key");
  });
});
