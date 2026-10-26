// This file was named after the old idle-wake pass; the current periodic
// matcher test lives here to retain the focused suite's CI ownership.
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SWARM_LEASE_TTL_SEC,
  DEFAULT_SWARM_MAX_ACTIVE_TASKS,
  DEFAULT_SWARM_CLAIM_SWEEP_INTERVAL_SEC,
  SWARM_CLAIM_QUEUE_ISSUE_STATUSES,
  SWARM_CLAIM_WAKE_REASON,
  SWARM_MATCHED_WAKE_REASON,
  type SwarmClaimLease,
  type SwarmClaimSettings,
  type SwarmQueueCandidate,
} from "@myrmidon/shared";
import { agentWakeupRequests, agents, chatConversations, companies, goals, heartbeatRuns, instanceSettings, issueClaims, issueLabels, issueRelations, issueThreadInteractions, issueWatchdogs, issues } from "@myrmidon/db";
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
    const updates: Array<{ table: unknown; patch: Record<string, unknown> }> = [];
    const expiredClaim = {
      id: "claim-old",
      issueId: "released-issue",
      agentId: "former-agent",
      heartbeatAt: NOW,
      expiresAt: new Date(NOW.getTime() - 60_000),
      releasedAt: null,
    };
    const idleAgent = {
      id: "idle-agent",
      companyId: "company-1",
      name: "Idle agent",
      reportsTo: null,
      role: "engineer",
      status: "idle",
      metadata: {},
    };
    const issue = {
      id: "released-issue",
      companyId: "company-1",
      identifier: "ENG-42",
      priority: "medium",
      createdAt: NOW,
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: null,
      hiddenAt: null,
      conversationAgentId: null,
      conversationUserId: null,
      parentId: null,
      projectId: null,
      casteKey: null,
      executionWorkspaceId: null,
      executionWorkspacePreference: null,
      executionWorkspaceSettings: null,
      responsibleUserId: null,
      createdByUserId: null,
    };
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
    const db = {
      query: { issues: issueTable },
      select: (projection: Record<string, unknown>) => ({
        from: (table: unknown) => {
          const selectQuery = {
            innerJoin: (joinedTable: unknown) => ({
              where: () => {
                if (joinedTable === issues || joinedTable === issueRelations) {
                  return {
                    orderBy: () => ({ limit: () => Promise.resolve([]) }),
                  };
                }
                return {
                  orderBy: () => Promise.resolve([
                    { id: "idle-agent", companyId: "company-1", name: "Idle agent", reportsTo: null, role: "engineer", status: "idle", metadata: {} },
                  ]),
                };
              },
            }),
            leftJoin: () => ({
              leftJoin: () => ({
                where: () => ({
                  orderBy: () => ({ limit: (limit: number) => Promise.resolve([{
                    issueId: "released-issue",
                    identifier: "ENG-42",
                    priority: "medium",
                    pheromoneStrength: 0,
                    failedRunsSinceLastChange: 0,
                    queuedAt: NOW,
                    assigneeAgentId: null,
                    projectId: null,
                  }].slice(0, limit)) }),
                }),
              }),
            }),
            where: () => {
              if (table === companies) {
                return {
                  limit: (limit: number) => Promise.resolve([{ id: "company-1" }].slice(0, limit)),
                  // resolveResponsibleUserIdForActivity ends with an unchained
                  // `.where()` + `.then()` read of the company's default
                  // responsible user (activity-log.ts); a bare { limit } object
                  // made `.then` a TypeError that the matcher pass swallowed.
                  then: (resolve: (rows: unknown[]) => unknown) =>
                    Promise.resolve([{ id: "company-1", defaultResponsibleUserId: null }]).then(resolve),
                };
              }
              if (table === instanceSettings) {
                return { then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([{ id: "settings-1", general: {}, experimental: {}, createdAt: NOW, updatedAt: NOW }]).then(resolve) };
              }
              if (table === goals) {
                return { orderBy: () => ({ then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([]).then(resolve) }) };
              }
              if (table === issueLabels) {
                return { orderBy: () => Promise.resolve([]) };
              }
              if (table === issueWatchdogs) {
                return Promise.resolve([]);
              }
              if (table === agentWakeupRequests) {
                return Promise.resolve([]);
              }
              if (table === heartbeatRuns) {
                return {
                  limit: () => Promise.resolve([]),
                  groupBy: empty,
                  then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([]).then(resolve),
                };
              }
              if (table === chatConversations) {
                return { limit: () => Promise.resolve([]) };
              }
              if (table === issueClaims) {
                if (projection && "agentId" in projection) return Promise.resolve([]);
                if (projection && "id" in projection) return { limit: () => Promise.resolve([]) };
                return {
                  orderBy: () => ({ limit: (limit: number) => Promise.resolve([expiredClaim].slice(0, limit)) }),
                };
              }
              if (table === agents && projection && "reportsTo" in projection) {
                return { then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([idleAgent]).then(resolve) };
              }
              if (table === issues && projection && "companyId" in projection && "assigneeAgentId" in projection) {
                // matchIssue re-reads the task to re-own it. The fixture keeps
                // the assignee set on this read (the mock clearExpiredAssignee
                // does not mutate the read row), so matchIssue returns null and
                // the periodic matchCompany pass is the one that claims it —
                // which is what result.idleClaimed counts.
                return { limit: (limit: number) => Promise.resolve([{ id: issue.id, companyId: issue.companyId, status: issue.status, assigneeAgentId: "former-agent" }].slice(0, limit)) };
              }
              if (projection && "agentId" in projection) return Promise.resolve([]);
              if (projection && "activeClaims" in projection) return Promise.resolve([]);
              return {
                orderBy: () => ({
                  limit: (limit: number) => Promise.resolve([issue].slice(0, limit)),
                }),
                limit: (limit: number) => Promise.resolve([issue].slice(0, limit)),
                groupBy: empty,
                then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([issue]).then(resolve),
                for: () => ({
                  then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([issue]).then(resolve),
                }),
              };
            },
            for: () => ({
              then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([
                { status: "todo", assigneeAgentId: null },
              ]).then(resolve),
            }),
          };
          return { ...selectQuery, where: selectQuery.where };
        },
      }),
      insert: () => ({
        values: () => ({
          returning: () => Promise.resolve([{
            id: "claim-new",
            issueId: "released-issue",
            agentId: "idle-agent",
            heartbeatAt: NOW,
            expiresAt: new Date(NOW.getTime() + 60_000),
            releasedAt: null,
          }]),
        }),
      }),
      update: (table?: unknown) => ({
        set: (patch: Record<string, unknown>) => ({
          where: () => ({
            // Ownership changes expire pending connection intents; an empty
            // expiry skips the follow-up delete (production: only when expired
            // rows exist). The issues write returns the updated row the service
            // then enriches — it must carry the fields the matcher reads back.
            returning: () => {
              updates.push({ table, patch: patch ?? {} });
              return Promise.resolve(
                table === issueThreadInteractions
                  ? []
                  : table === issues
                    ? [{ ...issue, ...(patch ?? {}), updatedAt: NOW }]
                    : [{ id: "released-issue" }],
              );
            },
          }),
        }),
      }),
      delete: () => ({
        where: () => Promise.resolve([]),
      }),
      // The capacity check takes a transaction advisory lock through raw SQL.
      execute: async () => [],
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
      castes: async () => [{
        role: "engineer",
        maxActiveTasks: null,
        swarmEligible: true,
      }],
      isIssueCoolingDown: async () => false,
      isAgentAvailable: async () => true,
      isTaskBudgetBlocked: async () => false,
      logActivity: async () => {},
    } as never);
    sweeper.resetForTest();
    const result = await sweeper.sweep(NOW);
    expect(result.idleClaimed).toBe(1);
    // The assignment lands through the issues service's conditional write (the
    // matcher claims via issueService.update, not the relational query API), so
    // the assertion reads the patch the fixture's update() recorded for the
    // issues table.
    expect(
      updates.some(
        (u) => u.table === issues && typeof u.patch.assigneeAgentId === "string",
      ),
    ).toBe(true);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.agentId).toBe("idle-agent");
    expect(wakes[0]!.opts).toMatchObject({
      // The matcher's own wake (production: SWARM_MATCHED_*), relayed through
      // the sweeper's enqueueWakeup port unchanged.
      reason: SWARM_MATCHED_WAKE_REASON,
      payload: expect.objectContaining({ issueId: "released-issue" }),
      contextSnapshot: expect.objectContaining({ issueId: "released-issue" }),
    });
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
