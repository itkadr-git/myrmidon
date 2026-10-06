// server/src/myrmidon/swarm-claim/idle-unassigned-assign.myrmidon.test.ts
//
// myrmidon(1.6.2 SWARM-UNASSIGNED-ROUTE): idle engineers take unassigned ready
// work. The shape of the field failure (04.10): many idle engineers, ready
// unassigned `todo` tasks, and zero wakes — the engineer queue was filled, in
// priority order, by tasks already assigned to busy peers, and the pass paired
// agent i with queue slot i, so the unassigned tasks behind them were never
// reached. Pinned here without a database: the pure decision, the role routing
// of an unassigned task, and the queue-row routing of the idle read.

import { describe, expect, it } from "vitest";
import {
  SWARM_DEFAULT_UNASSIGNED_ROLE,
  swarmRoleForUnassignedTask,
  swarmRoleFromLabels,
} from "@paperclipai/shared";
import { rolesOfQueueRow } from "./idle-queue.js";
import {
  idleWakeTargetsForRole,
  type SwarmIdleQueueCandidate,
  type SwarmRoleIdleInput,
} from "./idle-wake.js";

const NOW = new Date("2026-10-04T12:00:00Z");
const OPTIONS = { batchLimit: 25, now: NOW, p0Preemption: true };

function task(
  id: string,
  priority: string,
  day: number,
  assigneeAgentId: string | null = null,
): SwarmIdleQueueCandidate {
  return {
    issueId: id,
    identifier: id.toUpperCase(),
    priority,
    queuedAt: new Date(Date.UTC(2026, 9, day)),
    assigneeAgentId,
  };
}

function freeAgent(id: string) {
  return { id, activeClaims: 0, maxActiveTasks: 3, status: "idle", hasLiveRun: false };
}

describe("unassigned role routing", () => {
  it("a task with no role label is queued for the default work role", () => {
    expect(SWARM_DEFAULT_UNASSIGNED_ROLE).toBe("engineer");
    expect(swarmRoleForUnassignedTask([])).toBe("engineer");
    expect(swarmRoleForUnassignedTask(["backlog", "wellboard"])).toBe("engineer");
  });

  it("a role:<key> label wins; case and spaces are ignored", () => {
    expect(swarmRoleFromLabels(["x", "Role: QA "])).toBe("qa");
    expect(swarmRoleForUnassignedTask(["role:designer"])).toBe("designer");
    expect(swarmRoleFromLabels(["role:"])).toBeNull();
  });

  it("an unassigned ready row queues for ONE role, not for every role", () => {
    const base = { candidate: task("a", "medium", 1), assigneeAgentId: null, assigneeRole: null };
    expect(rolesOfQueueRow({ ...base, labels: [] })).toEqual(["engineer"]);
    expect(rolesOfQueueRow({ ...base, labels: ["role:qa"] })).toEqual(["qa"]);
  });

  it("an assigned row queues for its assignee's role; one with no role queues nowhere", () => {
    const base = { candidate: task("a", "medium", 1, "agent-x"), assigneeAgentId: "agent-x", labels: [] };
    expect(rolesOfQueueRow({ ...base, assigneeRole: "engineer" })).toEqual(["engineer"]);
    expect(rolesOfQueueRow({ ...base, assigneeRole: null })).toEqual([]);
  });
});

describe("idle engineers take unassigned work", () => {
  it("peers' assigned tasks do not crowd the unassigned tasks out of the pass", () => {
    // Ten high/critical tasks belong to busy peers; two medium tasks are
    // unassigned. Two free engineers must each get one of the unassigned two.
    const peers = Array.from({ length: 10 }, (_, i) =>
      task(`peer-${i}`, i % 2 ? "critical" : "high", 1 + i, `busy-${i}`),
    );
    const unassigned = [task("free-1", "medium", 20), task("free-2", "medium", 21)];
    const input: SwarmRoleIdleInput = {
      role: "engineer",
      queue: [...peers, ...unassigned],
      liveClaims: [],
      agents: [freeAgent("idle-a"), freeAgent("idle-b")],
    };
    const targets = idleWakeTargetsForRole(input, OPTIONS);
    expect(targets.map((t) => t.issueId)).toEqual(["free-1", "free-2"]);
    expect(targets.map((t) => t.agentId)).toEqual(["idle-a", "idle-b"]);
  });

  it("the highest-priority unassigned task goes first", () => {
    const input: SwarmRoleIdleInput = {
      role: "engineer",
      queue: [task("low", "low", 1), task("crit", "critical", 5), task("med", "medium", 2)],
      liveClaims: [],
      agents: [freeAgent("idle-a")],
    };
    expect(idleWakeTargetsForRole(input, OPTIONS).map((t) => t.issueId)).toEqual(["crit"]);
  });

  it("an agent takes its own assigned task before an unassigned one, and never a peer's", () => {
    const input: SwarmRoleIdleInput = {
      role: "engineer",
      queue: [
        task("peer", "critical", 1, "busy"),
        task("unassigned", "high", 2),
        task("mine", "low", 3, "idle-a"),
      ],
      liveClaims: [],
      agents: [freeAgent("idle-a"), freeAgent("idle-b")],
    };
    const targets = idleWakeTargetsForRole(input, OPTIONS);
    expect(targets.find((t) => t.agentId === "idle-a")?.issueId).toBe("mine");
    expect(targets.find((t) => t.agentId === "idle-b")?.issueId).toBe("unassigned");
    expect(targets.some((t) => t.issueId === "peer")).toBe(false);
  });

  it("one task is never bound to two agents", () => {
    const input: SwarmRoleIdleInput = {
      role: "engineer",
      queue: [task("only", "medium", 1)],
      liveClaims: [],
      agents: [freeAgent("idle-a"), freeAgent("idle-b")],
    };
    expect(idleWakeTargetsForRole(input, OPTIONS)).toHaveLength(1);
  });

  it("the batch cap still bounds the pass", () => {
    const input: SwarmRoleIdleInput = {
      role: "engineer",
      queue: Array.from({ length: 8 }, (_, i) => task(`t-${i}`, "medium", 1 + i)),
      liveClaims: [],
      agents: Array.from({ length: 8 }, (_, i) => freeAgent(`a-${i}`)),
    };
    expect(idleWakeTargetsForRole(input, { ...OPTIONS, batchLimit: 5 })).toHaveLength(5);
  });
});
