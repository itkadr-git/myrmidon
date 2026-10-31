// server/src/myrmidon/swarm-claim/capacity-policy-queue.myrmidon.test.ts
//
// myrmidon(1.6.6 P2.12 CAPACITY-POLICY, OPE-9202):
// Acceptance:
//   1. policy is enabled via feature flag in claim queue (settings / env);
//   2. default-off and rollback return prior behavior without a restart;
//   3. tests exclude invalid claims (covered by live lease, capacity limit).
// Cross-project claim exclusion (agent cannot claim a non-member project
// task) is covered on the real matcher/queue path in
// cross-project-load.myrmidon.test.ts (outsider agent + projectScopedClaimGate),
// not by an in-memory filter here.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_CAPACITY_POLICY,
  resolveSwarmClaimSettings,
  type CapacityPolicy,
  type SwarmClaimLease,
  type SwarmClaimSettings,
  type SwarmQueueCandidate,
} from "@myrmidon/shared";
import { nextQueueTaskForAgent, selectQueueForAgent } from "./domain.js";

const NOW = new Date("2026-10-31T12:00:00Z");

function makeCandidate(partial: Partial<SwarmQueueCandidate> & { issueId: string }): SwarmQueueCandidate {
  return {
    id: partial.issueId,
    issueId: partial.issueId,
    identifier: partial.identifier ?? `TASK-${partial.issueId.slice(0, 4)}`,
    priority: partial.priority ?? "medium",
    pheromoneStrength: partial.pheromoneStrength ?? 0,
    failedRunsSinceLastChange: partial.failedRunsSinceLastChange ?? 0,
    queuedAt: partial.queuedAt ?? NOW,
    projectId: partial.projectId ?? null,
    casteId: partial.casteId ?? "engineer",
    createdAt: partial.createdAt ?? partial.queuedAt ?? NOW,
  };
}

function makeLease(issueId: string, expiresAt: Date): SwarmClaimLease {
  return {
    id: `lease-${issueId}`,
    issueId,
    companyId: "comp-1",
    agentId: "agent-1",
    role: "engineer",
    claimedAt: new Date(NOW.getTime() - 60_000),
    heartbeatAt: new Date(NOW.getTime() - 10_000),
    expiresAt,
    releasedAt: null,
    releasedReason: null,
  };
}

const defaultSettings: SwarmClaimSettings = {
  enabled: true,
  leaseTtlSec: 120,
  maxActiveTasks: 5,
  sweepIntervalSec: 60,
  p0Preemption: true,
  pheromone: {},
  capacityPolicy: DEFAULT_CAPACITY_POLICY,
};

describe("1.6.6 CAPACITY-POLICY (OPE-9202): feature flag in claim queue", () => {
  it("default-off: capacityPolicy.enabled is false by default in resolved settings", () => {
    const { settings, sources } = resolveSwarmClaimSettings();
    expect(settings.capacityPolicy?.enabled).toBe(false);
    expect(sources.capacityPolicy).toBe("default");
  });

  it("enabled via environment feature flag MYRMIDON_CAPACITY_POLICY_ENABLED", () => {
    const { settings, sources } = resolveSwarmClaimSettings({
      env: { MYRMIDON_CAPACITY_POLICY_ENABLED: "true" },
    });
    expect(settings.capacityPolicy?.enabled).toBe(true);
    expect(sources.capacityPolicy).toBe("env");
  });

  it("enabled via stored settings row", () => {
    const customPolicy: CapacityPolicy = {
      enabled: true,
      fairness: { perProjectMaxShare: 0.5 },
      aging: { halfLifeMin: 30, maxBoost: 2 },
      limits: { perProjectActive: 2, perCasteActive: null },
      starvation: { afterMin: 30, promoteBy: 1 },
    };
    const { settings, sources } = resolveSwarmClaimSettings({
      stored: { ...defaultSettings, capacityPolicy: customPolicy },
    });
    expect(settings.capacityPolicy?.enabled).toBe(true);
    expect(sources.capacityPolicy).toBe("settings");
  });

  it("when flag is off, selectQueueForAgent keeps legacy order; when flag is on, applies capacity policy", () => {
    // Task 1: Project A, older (10:00)
    // Task 2: Project A, newer (11:00)
    // Task 3: Project B, newer (11:30)
    const taskA1 = makeCandidate({
      issueId: "task-a1",
      projectId: "proj-A",
      queuedAt: new Date("2026-10-31T10:00:00Z"),
      createdAt: new Date("2026-10-31T10:00:00Z"),
    });
    const taskA2 = makeCandidate({
      issueId: "task-a2",
      projectId: "proj-A",
      queuedAt: new Date("2026-10-31T11:00:00Z"),
      createdAt: new Date("2026-10-31T11:00:00Z"),
    });
    const taskB1 = makeCandidate({
      issueId: "task-b1",
      projectId: "proj-B",
      queuedAt: new Date("2026-10-31T11:30:00Z"),
      createdAt: new Date("2026-10-31T11:30:00Z"),
    });

    const candidates = [taskA1, taskA2, taskB1];

    // Legacy order (default-off): sorts strictly by queue order (A1, A2, B1)
    const legacyQueue = selectQueueForAgent({
      candidates,
      liveClaims: [],
      now: NOW,
      capacityPolicy: { ...DEFAULT_CAPACITY_POLICY, enabled: false },
    });
    expect(legacyQueue.map((c) => c.issueId)).toEqual(["task-a1", "task-a2", "task-b1"]);

    // Capacity policy enabled: the queue stays ordered by priority band first;
    // fairness is the final tie-break for candidates of equal effective rank
    // (orderCandidatesWithPolicy contract). With starvation promotion off
    // (afterMin beyond the fixture's ages) all three share one rank, so
    // Project fairness decides: Project A's share is capped at
    // ceil(3 * 0.5) = 2, putting Project B's task ahead of A's second task.
    const policyQueue = selectQueueForAgent({
      candidates,
      liveClaims: [],
      now: NOW,
      capacityPolicy: {
        ...DEFAULT_CAPACITY_POLICY,
        enabled: true,
        fairness: { perProjectMaxShare: 0.5 },
        starvation: { afterMin: 240, promoteBy: 1 },
      },
    });
    // With fairness, Project B gets scheduled before the second Project A task
    expect(policyQueue[0]?.issueId).toBe("task-a1");
    expect(policyQueue[1]?.issueId).toBe("task-b1");
    expect(policyQueue[2]?.issueId).toBe("task-a2");
  });
});

describe("1.6.6 CAPACITY-POLICY (OPE-9202): default-off and rollback", () => {
  it("switching enabled: true back to enabled: false immediately restores exact legacy behavior", () => {
    const task1 = makeCandidate({
      issueId: "task-1",
      projectId: "proj-A",
      queuedAt: new Date("2026-10-31T10:00:00Z"),
      createdAt: new Date("2026-10-31T10:00:00Z"),
    });
    const task2 = makeCandidate({
      issueId: "task-2",
      projectId: "proj-A",
      queuedAt: new Date("2026-10-31T10:30:00Z"),
      createdAt: new Date("2026-10-31T10:30:00Z"),
    });
    const task3 = makeCandidate({
      issueId: "task-3",
      projectId: "proj-B",
      queuedAt: new Date("2026-10-31T11:00:00Z"),
      createdAt: new Date("2026-10-31T11:00:00Z"),
    });
    const candidates = [task1, task2, task3];

    // Baseline: default-off
    const baseline = nextQueueTaskForAgent({
      candidates,
      liveClaims: [],
      activeTasks: 0,
      settings: { ...defaultSettings, capacityPolicy: { ...DEFAULT_CAPACITY_POLICY, enabled: false } },
      now: NOW,
    });
    expect(baseline?.issueId).toBe("task-1");

    // Enable policy: proj-A is at its per-project active ceiling (the metrics
    // come from the caller — see service.ts), so proj-A candidates are
    // rejected and proj-B's task is the top.
    const withPolicy = nextQueueTaskForAgent({
      candidates,
      liveClaims: [],
      activeTasks: 0,
      activeByProject: { "proj-A": 1, "proj-B": 0 },
      settings: {
        ...defaultSettings,
        capacityPolicy: {
          ...DEFAULT_CAPACITY_POLICY,
          enabled: true,
          limits: { perProjectActive: 1, perCasteActive: null },
        },
      },
      now: NOW,
    });
    expect(withPolicy?.issueId).toBe("task-3");

    // Rollback: disabled flag returns task-1 immediately without restart
    const rolledBack = nextQueueTaskForAgent({
      candidates,
      liveClaims: [],
      activeTasks: 0,
      settings: {
        ...defaultSettings,
        capacityPolicy: {
          ...DEFAULT_CAPACITY_POLICY,
          enabled: false,
          limits: { perProjectActive: 0, perCasteActive: null },
        },
      },
      now: NOW,
    });
    expect(rolledBack?.issueId).toBe("task-1");
  });
});

describe("1.6.6 CAPACITY-POLICY (OPE-9202): excludes invalid and cross-project claims", () => {
  it("excludes invalid claims: tasks covered by unexpired live leases are never selected", () => {
    const liveTask = makeCandidate({ issueId: "task-live", projectId: "proj-A" });
    const freeTask = makeCandidate({ issueId: "task-free", projectId: "proj-A" });

    const liveClaims = [makeLease("task-live", new Date(NOW.getTime() + 60_000))];

    const next = nextQueueTaskForAgent({
      candidates: [liveTask, freeTask],
      liveClaims,
      activeTasks: 0,
      settings: {
        ...defaultSettings,
        capacityPolicy: { ...DEFAULT_CAPACITY_POLICY, enabled: true },
      },
      now: NOW,
    });

    expect(next?.issueId).toBe("task-free");
  });

  it("excludes invalid claims: tasks exceeding per-project active capacity limit are rejected", () => {
    const taskA = makeCandidate({ issueId: "task-a", projectId: "proj-A" });
    const taskB = makeCandidate({ issueId: "task-b", projectId: "proj-B" });

    // Project A already has 2 active tasks, exceeding limit of 2
    const next = nextQueueTaskForAgent({
      candidates: [taskA, taskB],
      liveClaims: [],
      activeTasks: 0,
      settings: {
        ...defaultSettings,
        capacityPolicy: {
          ...DEFAULT_CAPACITY_POLICY,
          enabled: true,
          limits: { perProjectActive: 2, perCasteActive: null },
        },
      },
      activeByProject: { "proj-A": 2, "proj-B": 0 },
      now: NOW,
    });

    // task-a is rejected by capacity limits; task-b is selected
    expect(next?.issueId).toBe("task-b");
  });
});
