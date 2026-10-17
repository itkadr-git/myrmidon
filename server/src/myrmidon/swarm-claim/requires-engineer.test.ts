import { describe, expect, it } from "vitest";
import {
  isCheckoutRequiredPreference,
  requiresEngineer,
} from "./requires-engineer.js";

const hasEngineerLabel = { labels: ["needs-engineer"] };

describe("requiresEngineer", () => {
  it("recognizes the explicit needs-engineer label", () => {
    expect(requiresEngineer(hasEngineerLabel)).toBe(true);
  });

  it("uses the effective caste before the legacy role label", () => {
    expect(requiresEngineer({ casteKey: "engineer", labels: ["role:qa"] })).toBe(true);
    expect(requiresEngineer({ casteKey: "general", labels: ["role:engineer"] })).toBe(false);
    expect(requiresEngineer({ projectDefaultCasteKey: "engineer" })).toBe(true);
  });

  it("recognizes legacy engineer routing and defaults to the general pool", () => {
    expect(requiresEngineer({ labels: ["Role: Engineer"] })).toBe(true);
    expect(requiresEngineer({})).toBe(false);
    expect(requiresEngineer({ labels: ["role:qa"] })).toBe(false);
  });

  it("classifies only current checkout-bound harness/workspace values", () => {
    expect(requiresEngineer({ harnessKind: "skill_test" })).toBe(true);
    expect(requiresEngineer({ executionWorkspacePreference: "inherit" })).toBe(false);
    expect(requiresEngineer({ executionWorkspacePreference: "reuse_existing" })).toBe(true);
    expect(requiresEngineer({ executionWorkspacePreference: "isolated" as never })).toBe(false);
  });

  it("does not infer from unrelated labels or prose signals", () => {
    expect(requiresEngineer({ labels: ["backend"], harnessKind: "custom" })).toBe(false);
  });
});

describe("isCheckoutRequiredPreference", () => {
  it.each(["operator_branch", "reuse_existing"])("classifies %s as checkout-bound", (value) => {
    expect(isCheckoutRequiredPreference(value)).toBe(true);
  });

  it.each(["isolated", "none", "invalid", undefined])("keeps %s fail-open", (value) => {
    expect(isCheckoutRequiredPreference(value)).toBe(false);
  });
});
