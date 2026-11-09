import { describe, expect, it } from "vitest";
import {
  isCheckoutRequiredPreference,
  normalizeLabels,
  shouldSkipContinuation,
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
    expect(requiresEngineer({ executionWorkspacePreference: "isolated_workspace" })).toBe(false);
  });

  it("does not infer from unrelated labels or prose signals", () => {
    expect(requiresEngineer({ labels: ["backend"], harnessKind: "custom" })).toBe(false);
  });

  it("handles labels formatted as JSON strings or object arrays", () => {
    expect(requiresEngineer({ labels: JSON.stringify(["needs-engineer"]) as any })).toBe(true);
    expect(requiresEngineer({ labels: [{ name: "needs-engineer" }] as any })).toBe(true);
    expect(normalizeLabels('["foo", "bar"]')).toEqual(["foo", "bar"]);
    expect(normalizeLabels([{ name: "hello" }])).toEqual(["hello"]);
    expect(normalizeLabels(null)).toEqual([]);
  });
});

describe("isCheckoutRequiredPreference", () => {
  it.each(["operator_branch", "reuse_existing"])("classifies %s as checkout-bound", (value) => {
    expect(isCheckoutRequiredPreference(value)).toBe(true);
  });

  it.each(["isolated", "isolated_workspace", "none", "invalid", undefined])("keeps %s fail-open", (value) => {
    expect(isCheckoutRequiredPreference(value)).toBe(false);
  });
});

describe("shouldSkipContinuation", () => {
  it("skips reviewer continuations for engineer issues", () => {
    expect(shouldSkipContinuation({ agentRole: "reviewer", issueRole: "engineer" })).toBe(true);
  });

  it("keeps matching engineer continuations", () => {
    expect(shouldSkipContinuation({ agentRole: "engineer", issueRole: "engineer" })).toBe(false);
  });

  it("fails open when either role is missing", () => {
    expect(shouldSkipContinuation({ agentRole: null, issueRole: "engineer" })).toBe(false);
    expect(shouldSkipContinuation({ agentRole: "engineer" })).toBe(false);
  });
});
