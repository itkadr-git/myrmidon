import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { METRIC_FAMILIES } from "../metrics/metrics.js";
import {
  CAPACITY_POLICY_PANELS,
  assertCapacityPolicySourcesRegistered,
  resolveCapacityPolicyPanels,
} from "./capacity-policy.js";

describe("capacity policy dashboard preparation", () => {
  it("exports five distinct panels with project and rejection dimensions", () => {
    expect(CAPACITY_POLICY_PANELS).toHaveLength(5);
    expect(new Set(CAPACITY_POLICY_PANELS.map((panel) => panel.id)).size).toBe(5);
    expect(new Set(CAPACITY_POLICY_PANELS.map((panel) => panel.metric)).size).toBe(5);
    expect(CAPACITY_POLICY_PANELS.find((panel) => panel.id === "project-share")?.groupBy).toEqual(["project"]);
    expect(CAPACITY_POLICY_PANELS.find((panel) => panel.id === "claim-rejection")?.groupBy).toEqual(["reason"]);
    expect(CAPACITY_POLICY_PANELS.filter((panel) => panel.kind === "counter")).toHaveLength(2);
  });

  it("checks the real metric registry and refuses incomplete integration", () => {
    const registry: ReadonlySet<string> = new Set(METRIC_FAMILIES);
    const panels = resolveCapacityPolicyPanels();
    for (const panel of panels) {
      expect(panel.sourceStatus).toBe(registry.has(panel.metric) ? "registered" : "unavailable");
      expect(panel.missingValue).toBeNull();
    }
    const missing = panels.filter((panel) => !registry.has(panel.metric));
    if (missing.length) {
      expect(assertCapacityPolicySourcesRegistered).toThrow("sources are not registered");
      for (const panel of missing) expect(assertCapacityPolicySourcesRegistered).toThrow(panel.metric);
    } else {
      expect(assertCapacityPolicySourcesRegistered).not.toThrow();
    }
    // This verifies fail-closed preparation, not delivery acceptance.
    // B11 integration must call the assertion and verify real source samples.
  });

  it.each(["", ".ru"])("keeps canary steps, stop thresholds and rollback in %s runbook", (language) => {
    const document = readFileSync(new URL(`../../../../../docs/myrmidon/guides/capacity-policy-canary${language}.md`, import.meta.url), "utf8");
    for (const section of ["Status", "Prerequisites", "Per-project enablement", "Stop thresholds", "Rollback", "Evidence"]) {
      expect(document).toContain(`## ${section}`);
    }
    for (const panel of CAPACITY_POLICY_PANELS) expect(document).toContain(panel.metric);
    expect(document).toContain("enabled=false");
    expect(document).toContain("NOT EXECUTED");
    expect(document).toContain("OPE-9202");
  });
});
