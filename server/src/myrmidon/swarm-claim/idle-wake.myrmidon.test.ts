// This file was named after the old idle-wake pass; the current periodic
// matcher test lives here to retain the focused suite's CI ownership.
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SWARM_LEASE_TTL_SEC,
  DEFAULT_SWARM_MAX_ACTIVE_TASKS,
  DEFAULT_SWARM_CLAIM_SWEEP_INTERVAL_SEC,
  SWARM_CLAIM_QUEUE_ISSUE_STATUSES,
  SWARM_CLAIM_WAKE_REASON,
  type SwarmClaimLease,
  type SwarmClaimSettings,
  type SwarmQueueCandidate,
} from "@paperclipai/shared";
import { claimCovers, selectQueueForAgent } from "./domain.js";
import { createSwarmClaimSweeper } from "./sweep.js";
import type { SwarmClaimEnqueueWakeup } from "./service.js";

const NOW = new Date("2026-10-03T12:00:00Z");

function candidate(overrides: Partial<SwarmQueueCandidate> = {}): SwarmQueueCandidate {
  return {
    issueId: "11111111-1111-4111-8111-111111111111",
    identifier: "ISSUE-1",
    priority: "medium",
    queuedAt: new Date("2026-10-03T10:00:00Z"),
    ...overrides,
  };
}

function lease(overrides: Partial<SwarmClaimLease> = {}): SwarmClaimLease {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    issueId: "11111111-1111-4111-8111-111111111111",
    agentId: "33333333-3333-4333-8333-333333333333",
    heartbeatAt: NOW,
    expiresAt: new Date(NOW.getTime() + 60_000),
    releasedAt: null,
    ...overrides,
  };
}

describe("myrmidon(1.6.1 SWARM-IDLE-WAKE) released work", () => {
  it("an expired release no longer covers its task, which returns to the ready queue", () => {
    const released = lease({
      expiresAt: new Date(NOW.getTime() - 60_000),
      releasedAt: new Date(NOW.getTime() - 30_000),
    });
    const candidates = [
      candidate({ issueId: released.issueId }),
      candidate({ issueId: "next-issue", identifier: "ISSUE-2" }),
    ];

    expect(claimCovers(released, NOW)).toBe(false);
    expect(selectQueueForAgent({ candidates, liveClaims: [released], now: NOW })[0]?.issueId)
      .toBe(released.issueId);
  });
});

describe("myrmidon(1.6.1 SWARM-IDLE-WAKE) sweep pass", () => {
  it("E2-E5: the next sweep hands released work to its new owner", async () => {
    const wakes: Array<{ agentId: string; opts: Record<string, unknown> }> = [];
    const empty = <T>() => Promise.resolve([] as T[]);
    const issueTable = {
      findMany: vi.fn(async () => [{
        id: "released-issue",
        identifier: "ENG-42",
        priority: "medium",
        createdAt: NOW,
        status: "todo",
        assigneeAgentId: null,
        projectId: null,
      }]),
      update: vi.fn(async () => [{ id: "released-issue" }]),
    };
    const queryResult = <T>(rows: T[] = []) => ({
      limit: (limit: number) => Promise.resolve(rows.slice(0, limit)),
      then: (resolve: (value: T[]) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject),
    });
    const db = {
      query: { issues: issueTable },
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: () => ({
              orderBy: () => ({
                limit: (limit: number) => Promise.resolve([
                  { id: "idle-agent", companyId: "company-1", name: "Idle agent", reportsTo: null, role: "engineer", status: "idle", metadata: {} },
                ].slice(0, limit)),
              }),
              groupBy: empty,
              limit: empty,
              then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([
                { claim: { id: "claim-old", issueId: "released-issue", agentId: "former-agent", heartbeatAt: NOW, expiresAt: new Date(NOW.getTime() - 60_000), releasedAt: null } },
              ]).then(resolve),
            }),
          }),
          leftJoin: () => ({
            leftJoin: () => ({
              where: () => ({
                orderBy: () => Promise.resolve([
                  {
                    issueId: "released-issue",
                    identifier: "ENG-42",
                    priority: "medium",
                    pheromoneStrength: 0,
                    failedRunsSinceLastChange: 0,
                    queuedAt: NOW,
                    assigneeAgentId: null,
                    projectId: null,
                  },
                ]),
              }),
            }),
          }),
          where: () => ({
            orderBy: () => ({ limit: empty }),
            groupBy: empty,
            limit: (limit: number) => Promise.resolve([
              { id: "released-issue", status: "todo", assigneeAgentId: null },
            ].slice(0, limit)),
            then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([
              { id: "released-issue", status: "todo", assigneeAgentId: null },
            ]).then(resolve),
          }),
          for: () => queryResult(),
        }),
      }),
      insert: () => ({ values: () => ({ returning: empty }) }),
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    };
    const settings: SwarmClaimSettings = {
      enabled: true,
      leaseTtlSec: DEFAULT_SWARM_LEASE_TTL_SEC,
      maxActiveTasks: DEFAULT_SWARM_MAX_ACTIVE_TASKS,
      sweepIntervalSec: DEFAULT_SWARM_CLAIM_SWEEP_INTERVAL_SEC,
      p0Preemption: true,
      pheromone: {},
    };
    const sweeper = createSwarmClaimSweeper({
      db: db as never,
      settings: { getGeneral: async () => ({ swarmClaim: settings }) },
      env: {},
      intervalMs: 0,
      hostMemoryGate: () => ({ state: "open" } as never),
      hostCpuGate: () => ({ state: "open" } as never),
      enqueueWakeup: async (agentId: string, opts: Parameters<SwarmClaimEnqueueWakeup>[1]) => {
        wakes.push({ agentId, opts: opts as unknown as Record<string, unknown> });
        return { id: "wake-next" } as never;
      },
      castes: async () => [],
      isIssueCoolingDown: async () => false,
      isAgentAvailable: async () => true,
      isTaskBudgetBlocked: async () => false,
      logActivity: async () => {},
    } as never);
    sweeper.resetForTest();
    const result = await sweeper.sweep(NOW);
    expect(result.idleClaimed).toBe(1);
    expect(issueTable.update).toHaveBeenCalledWith(expect.objectContaining({
      set: expect.objectContaining({ assigneeAgentId: expect.any(String) }),
    }));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.opts).toMatchObject({ issueId: "released-issue", taskKey: "released-issue" });
    expect(SWARM_CLAIM_WAKE_REASON).toBe("swarm_claim_queue");
    expect(SWARM_CLAIM_QUEUE_ISSUE_STATUSES).toContain("todo");
  });
});

describe("myrmidon(1.6-SWARM) sweep acceptance window", () => {
  it("the default sweep interval is no longer than one lease TTL", () => {
    expect(DEFAULT_SWARM_CLAIM_SWEEP_INTERVAL_SEC).toBeLessThanOrEqual(
      DEFAULT_SWARM_LEASE_TTL_SEC,
    );
  });
});
