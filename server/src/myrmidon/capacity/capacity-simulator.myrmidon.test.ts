// server/src/myrmidon/capacity/capacity-simulator.myrmidon.test.ts
//
// myrmidon(1.6.6 P2.12 CAPACITY-POLICY SIMULATOR ACCEPTANCE, OPE-9200):
// Replay-симулятор сравнивает readiness ratio до/после политики
// на фиксированной фикстуре (OPE-9199, OPE-8312 §5.12).

import { describe, expect, it } from "vitest";
import {
  DEFAULT_1_6_6_FIXTURE_PATH,
  compareCapacityPolicyReplay,
  deriveAgentsFromSnapshot,
  formatReplayReport,
  loadSnapshotFixture,
  runCapacityReplaySimulation,
} from "./capacity-simulator.js";
import { DEFAULT_CAPACITY_POLICY } from "@myrmidon/shared";

describe("capacity policy replay simulator (OPE-9200 / 1.6.6 P2.12)", () => {
  const snapshot = loadSnapshotFixture(DEFAULT_1_6_6_FIXTURE_PATH);

  it("loads the fixed 1.6.6 fixture with 276 issues and 94 relations", () => {
    expect(snapshot.issues.length).toBe(276);
    expect(snapshot.issueRelations.length).toBe(94);
    expect(snapshot.metrics.totalOpenIssues).toBe(276);
    expect(snapshot.metrics.readyIssuesCount).toBe(100);
  });

  it("derives deterministic agent roster with full project coverage", () => {
    const agents = deriveAgentsFromSnapshot(snapshot);
    expect(agents.length).toBeGreaterThan(0);

    // Collect all project IDs from snapshot
    const projectIds = new Set<string>();
    for (const issue of snapshot.issues) {
      if (issue.projectId) projectIds.add(issue.projectId);
    }

    // Verify every project has at least one assigned agent
    for (const projectId of projectIds) {
      const hasCoverage = agents.some((a) => a.projectIds.includes(projectId));
      expect(hasCoverage).toBe(true);
    }
  });

  it("compares readiness ratio before and after policy on the fixed fixture", () => {
    const result = compareCapacityPolicyReplay({
      snapshot,
      maxSteps: 30,
      taskDurationSteps: 2,
    });

    const { beforePolicy, afterPolicy, comparison } = result;

    // Both runs started from the exact same snapshot state
    expect(comparison.initialReadinessRatio.before).toBeCloseTo(
      comparison.initialReadinessRatio.after,
      4
    );

    // Acceptance 1: Readiness ratio increases after policy
    expect(comparison.readinessRatioIncreased).toBe(true);
    expect(afterPolicy.averageReadinessRatio).toBeGreaterThan(
      beforePolicy.averageReadinessRatio
    );
    expect(afterPolicy.finalReadinessRatio).toBeGreaterThan(
      beforePolicy.finalReadinessRatio
    );

    // Acceptance 2: Invalid claims metric is tracked and does NOT increase (zero invalid claims)
    expect(beforePolicy.metrics.invalidClaims).toBe(0);
    expect(afterPolicy.metrics.invalidClaims).toBe(0);
    expect(comparison.invalidClaims.increased).toBe(false);

    // Acceptance 3: Cross-project claims metric is tracked and does NOT increase (zero cross-project claims)
    expect(beforePolicy.metrics.crossProjectClaims).toBe(0);
    expect(afterPolicy.metrics.crossProjectClaims).toBe(0);
    expect(comparison.crossProjectClaims.increased).toBe(false);

    // Acceptance 4: Overall claims integrity is preserved
    expect(comparison.claimsIntegrityPreserved).toBe(true);

    // Policy mechanics: Capacity limits produce recorded rejections
    expect(afterPolicy.metrics.claimRejections.total).toBeGreaterThan(0);
    expect(
      (afterPolicy.metrics.claimRejections.byReason.project_limit ?? 0) +
        (afterPolicy.metrics.claimRejections.byReason.caste_limit ?? 0)
    ).toBeGreaterThan(0);

    // Output formatting verification
    const report = formatReplayReport(result);
    expect(report).toContain("CAPACITY POLICY REPLAY SIMULATION REPORT");
    expect(report).toContain("VERIFICATION STATUS:");
    expect(report).toContain("PASS");
  });

  it("produces strictly deterministic replay results", () => {
    const run1 = compareCapacityPolicyReplay({
      snapshot,
      maxSteps: 15,
      taskDurationSteps: 2,
    });

    const run2 = compareCapacityPolicyReplay({
      snapshot,
      maxSteps: 15,
      taskDurationSteps: 2,
    });

    expect(run1.beforePolicy.averageReadinessRatio).toBe(
      run2.beforePolicy.averageReadinessRatio
    );
    expect(run1.afterPolicy.averageReadinessRatio).toBe(
      run2.afterPolicy.averageReadinessRatio
    );
    expect(run1.afterPolicy.metrics.totalClaims).toBe(
      run2.afterPolicy.metrics.totalClaims
    );
    expect(run1.afterPolicy.metrics.claimRejections.total).toBe(
      run2.afterPolicy.metrics.claimRejections.total
    );
  });

  it("supports policy rollback with enabled=false identical to beforePolicy", () => {
    const disabledRun = runCapacityReplaySimulation({
      snapshot,
      policy: { ...DEFAULT_CAPACITY_POLICY, enabled: false },
      maxSteps: 15,
      taskDurationSteps: 2,
    });

    const compareResult = compareCapacityPolicyReplay({
      snapshot,
      maxSteps: 15,
      taskDurationSteps: 2,
    });

    expect(disabledRun.averageReadinessRatio).toBe(
      compareResult.beforePolicy.averageReadinessRatio
    );
    expect(disabledRun.finalReadinessRatio).toBe(
      compareResult.beforePolicy.finalReadinessRatio
    );
    expect(disabledRun.metrics.totalClaims).toBe(
      compareResult.beforePolicy.metrics.totalClaims
    );
  });

  it("handles custom agent pools and step counts cleanly", () => {
    const customAgents = [
      {
        id: "custom-eng-1",
        casteKey: "engineering",
        projectIds: ["f05bb43a-73d8-4f24-9549-b63d91782e44"],
        maxConcurrency: 1,
      },
      {
        id: "custom-eng-2",
        casteKey: "engineering",
        projectIds: ["47a9dccd-78f0-4431-9ee7-b7c2ca2c1a6b"],
        maxConcurrency: 1,
      },
    ];

    const result = compareCapacityPolicyReplay({
      snapshot,
      agents: customAgents,
      maxSteps: 10,
      taskDurationSteps: 1,
    });

    expect(result.beforePolicy.steps.length).toBe(10);
    expect(result.afterPolicy.steps.length).toBe(10);
    expect(result.afterPolicy.metrics.invalidClaims).toBe(0);
    expect(result.afterPolicy.metrics.crossProjectClaims).toBe(0);
  });
});
