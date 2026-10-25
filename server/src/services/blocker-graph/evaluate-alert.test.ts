import { describe, expect, it } from "vitest";
import type { BlockerRootFanout } from "@myrmidon/shared";
import { DEFAULT_ROOT_FANOUT_LIMIT, evaluateRootFanoutAlerts } from "./evaluate-alert.js";

function root(rootIssueId: string, dependentCount: number): BlockerRootFanout {
  return {
    rootIssueId,
    rootIdentifier: rootIssueId,
    rootStatus: "blocked",
    dependentCount,
    dependents: [],
    oldestBlockedAt: null,
    hasMissingFields: false,
  };
}

describe("evaluateRootFanoutAlerts", () => {
  it("alerts for a twenty-dependent root over the default limit of ten", () => {
    expect(DEFAULT_ROOT_FANOUT_LIMIT).toBe(10);
    expect(evaluateRootFanoutAlerts([root("OPE-8079", 20)], DEFAULT_ROOT_FANOUT_LIMIT)).toEqual([
      { rootIssueId: "OPE-8079", dependentCount: 20, limit: 10, severity: "warning" },
    ]);
  });

  it("does not alert when a root is exactly at the limit", () => {
    expect(evaluateRootFanoutAlerts([root("at-limit", 10)], 10)).toEqual([]);
  });

  it("returns one alert for each root above the limit", () => {
    expect(evaluateRootFanoutAlerts([root("first", 11), root("second", 20)], 10)).toEqual([
      { rootIssueId: "first", dependentCount: 11, limit: 10, severity: "warning" },
      { rootIssueId: "second", dependentCount: 20, limit: 10, severity: "warning" },
    ]);
  });

  it("uses a caller-supplied configured limit", () => {
    expect(evaluateRootFanoutAlerts([root("configured", 11)], 12)).toEqual([]);
    expect(evaluateRootFanoutAlerts([root("configured", 13)], 12)).toEqual([
      { rootIssueId: "configured", dependentCount: 13, limit: 12, severity: "warning" },
    ]);
  });
});
