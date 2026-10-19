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
} from "@paperclipai/shared";
import { agentWakeupRequests, agents, chatConversations, companies, goals, heartbeatRuns, instanceSettings, issueClaims, issueLabels, issueThreadInteractions, issueWatchdogs, issues } from "@paperclipai/db";
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
    const updates: Array<{ table: unknown; patch: Record<string, unknown>; where?: unknown }> = [];
    const expiredClaim = {
      id: "claim-old",
      companyId: "company-1",
      issueId: "released-issue",
      agentId: "former-agent",
      runId: null,
      heartbeatAt: NOW,
      expiresAt: new Date(NOW.getTime() - 60_000),
      releasedAt: null,
    };
    let claimState = { ...expiredClaim };
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
      assigneeAgentId: "former-agent",
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
    let issueState: { [key: string]: unknown } = { ...issue };
    const issueTable = {
      findMany: vi.fn(async () => [{
        id: "released-issue",
        identifier: "ENG-42",
        priority: "medium",
        createdAt: NOW,
        status: issueState.status,
        assigneeAgentId: issueState.assigneeAgentId,
        projectId: null,
      }]),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        issueState = { ...issueState, ...data, updatedAt: NOW };
        return [{ ...issueState }];
      }),
    };
    const db = {
      query: { issues: issueTable },
      select: (projection: Record<string, unknown>) => ({
        from: (table: unknown) => {
          const selectQuery = {
            innerJoin: (joinedTable: unknown) => {
              if (table === agents && joinedTable === companies) {
                const directoryRows = [idleAgent];
                return { where: () => ({ orderBy: () => Promise.resolve(directoryRows) }) };
              }
              if (table === issueClaims && projection && "agentId" in projection) {
                // The active-claim census is consumed as a Map; once the
                // expired claim is released the replacement owner has none.
                const rows = claimState && !claimState.releasedAt && claimState.agentId === "idle-agent"
                  ? [{ agentId: "idle-agent" }]
                  : [];
                return { where: () => Promise.resolve(rows) };
              }
              if (table === issues && projection && "issueId" in projection) {
                const rows = issueState.assigneeAgentId === null ? [{
                  issueId: issueState.id,
                  identifier: "ENG-42",
                  priority: "medium",
                  pheromoneStrength: 0,
                  failedRunsSinceLastChange: 0,
                  queuedAt: NOW,
                  assigneeAgentId: issueState.assigneeAgentId,
                  projectId: null,
                }] : [];
                return { where: () => ({ orderBy: () => ({ limit: (limit: number) => Promise.resolve(rows.slice(0, limit)) }) }) };
              }
              if (joinedTable === companies) {
                return {
                  where: () => ({ orderBy: () => Promise.resolve([idleAgent]) }),
                };
              }
              const rows: unknown[] = [];
              return {
                where: () => ({
                  orderBy: () => ({
                    limit: (limit: number) => Promise.resolve(rows.slice(0, limit)),
                    then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
                  }),
                  limit: (limit: number) => Promise.resolve(rows.slice(0, limit)),
                  then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
                }),
              };
            },
            leftJoin: () => ({
              leftJoin: () => ({
                where: () => ({
                  orderBy: () => ({
                    limit: (limit: number) => Promise.resolve((issueState.assigneeAgentId === null || issueState.assigneeAgentId === "former-agent" ? [{
                      issueId: "released-issue",
                      identifier: "ENG-42",
                      priority: "medium",
                      pheromoneStrength: 0,
                      failedRunsSinceLastChange: 0,
                      queuedAt: NOW,
                      assigneeAgentId: issueState.assigneeAgentId,
                      projectId: null,
                    }] : []).slice(0, limit)),
                  }),
                }),
              }),
            }),
            where: () => {
              if (table === heartbeatRuns && projection && "id" in projection) {
                // hasLiveRunForTask probes this exact projection; the fixture
                // has no run for the released task, so reclaim may proceed.
                return { limit: () => Promise.resolve([]) };
              }
              if (table === issueClaims && projection && "id" in projection) {
                // insertClaim's uniqueness guard must observe the old lease
                // after release as inactive, not reuse the expired row.
                return { limit: () => Promise.resolve([]) };
              }
              if (table === companies && projection && "id" in projection) {
                // listActiveCompanies selects directly from companies; the
                // joined matcher directory is handled by innerJoin below.
                return { limit: (limit: number) => Promise.resolve([{ id: "company-1" }].slice(0, limit)) };
              }
              if (table === companies) {
                return {
                  limit: (limit: number) => Promise.resolve([{ id: "company-1" }].slice(0, limit)),
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
                // issueHasLiveClaimOrWake bounds the wake lookup with limit(1).
                return { limit: () => Promise.resolve([]) };
              }
              if (table === heartbeatRuns) {
                if (projection && "id" in projection) return { limit: () => Promise.resolve([]) };
                // listIdleRolePairs awaits the live-run directory directly, while
                // the last-run aggregate uses groupBy().
                if (projection && "agentId" in projection && !("lastActiveAt" in projection)) {
                  return Promise.resolve([]);
                }
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
                // The matcher's ready-queue projection comes from issues (the
                // outer table), not issue_claims; claim reads with { id } are
                // the live-claim guard used before inserting the new lease.
                if (projection && "id" in projection) return { limit: () => Promise.resolve([]) };
                // listExpiredClaims selects the complete table row before the
                // release write; later claim reads must observe claimState.
                if (!projection) {
                  return { orderBy: () => ({ limit: (limit: number) => Promise.resolve([expiredClaim].slice(0, limit)) }) };
                }
                if ("issueId" in projection) {
                  // matchIssue reads the ready-queue projection for the expired
                  // task after reclaim; it must see the state after assignee clear.
                  return { orderBy: () => ({ limit: (limit: number) => Promise.resolve([{
                    issueId: issueState.id,
                    identifier: "ENG-42",
                    priority: "medium",
                    pheromoneStrength: 0,
                    failedRunsSinceLastChange: 0,
                    queuedAt: NOW,
                    assigneeAgentId: issueState.assigneeAgentId,
                    projectId: null,
                  }].slice(0, limit)) }) };
                }
                return {
                  orderBy: () => ({ limit: (limit: number) => Promise.resolve(claimState && !claimState.releasedAt ? [claimState].slice(0, limit) : []) }),
                };
              }
              if (table === agents && projection && "reportsTo" in projection) {
                // Direct company-agent lookup is awaited after .where(); the
                // joined directory above owns the .where().orderBy() chain.
                return Promise.resolve([idleAgent]);
              }
              if (table === issues && projection && "issueId" in projection) {
                // Ready-queue candidates are selected from issues and the
                // production query uses left joins only for enrichment.
                return {
                  orderBy: () => ({
                    limit: (limit: number) => Promise.resolve((issueState.assigneeAgentId === null ? [{
                      issueId: issueState.id,
                      identifier: "ENG-42",
                      priority: "medium",
                      pheromoneStrength: 0,
                      failedRunsSinceLastChange: 0,
                      queuedAt: NOW,
                      assigneeAgentId: issueState.assigneeAgentId,
                      projectId: null,
                    }] : []).slice(0, limit)),
                  }),
                };
              }
              if (table === issues && projection && "companyId" in projection && "assigneeAgentId" in projection) {
                // matchIssue re-reads the task after clearExpiredAssignee has
                // committed its conditional update, so this read observes the
                // released assignment as an available queue item.
                return {
                  limit: (limit: number) => Promise.resolve([{ id: issueState.id, companyId: issueState.companyId, status: issueState.status, assigneeAgentId: issueState.assigneeAgentId }].slice(0, limit)),
                  for: () => Promise.resolve([{ id: issueState.id, companyId: issueState.companyId, status: issueState.status, assigneeAgentId: issueState.assigneeAgentId }]),
                };
              }
              if (projection && "agentId" in projection) return Promise.resolve([]);
              if (projection && "activeClaims" in projection) return Promise.resolve([]);
              return {
                orderBy: () => ({
                  limit: (limit: number) => Promise.resolve([issueState].slice(0, limit)),
                  then: (resolve: (value: unknown[]) => unknown) => Promise.resolve([issueState]).then(resolve),
                }),
                limit: (limit: number) => Promise.resolve([issueState].slice(0, limit)),
                groupBy: empty,
                then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([issueState]).then(resolve),
                for: () => ({
                  then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([issueState]).then(resolve),
                }),
              };
            },
            for: () => ({
              then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([
                { status: issueState.status, assigneeAgentId: issueState.assigneeAgentId },
              ]).then(resolve),
            }),
          };
          return { ...selectQuery, where: selectQuery.where };
        },
      }),
      insert: () => ({
        values: (value: Record<string, unknown>) => ({
          returning: () => {
            claimState = {
              ...claimState,
              ...value,
              id: "claim-new",
              issueId: "released-issue",
              agentId: "idle-agent",
              heartbeatAt: NOW,
              expiresAt: new Date(NOW.getTime() + 60_000),
              releasedAt: null,
            };
            return Promise.resolve([claimState]);
          },
        }),
      }),
      update: (table?: unknown) => ({
        set: (patch: Record<string, unknown>) => ({
          where: (condition: unknown) => ({
            // Ownership changes expire pending connection intents; an empty
            // expiry skips the follow-up delete (production: only when expired
            // rows exist). The issues write returns the updated row the service
            // then enriches — it must carry the fields the matcher reads back.
            returning: () => {
              updates.push({ table, patch: patch ?? {}, where: condition });
              if (table === issueClaims && patch?.releasedAt) {
                claimState = { ...claimState, ...patch };
              }
              if (table === issues && patch) {
                // Only the guarded clear/reassign update may mutate fixture state.
                if (patch.assigneeAgentId === null && issueState.assigneeAgentId === "former-agent") {
                  issueState = { ...issueState, ...patch, updatedAt: NOW };
                } else if (patch.assigneeAgentId === "idle-agent" && issueState.assigneeAgentId === null) {
                  issueState = { ...issueState, ...patch, updatedAt: NOW };
                }
              }
              return Promise.resolve(
                table === issueThreadInteractions
                  ? []
                  : table === issues
                    ? [issueState]
                    : [{ id: "released-issue" }],
              );
            },
          }),
        }),
      }),
      delete: () => ({
        where: () => Promise.resolve([]),
      }),
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
    expect(claimState).toMatchObject({ agentId: "idle-agent", releasedAt: null });
    expect(issueState.assigneeAgentId).toBe("idle-agent");
    const releaseIndex = updates.findIndex((u) => u.table === issueClaims && u.patch.releasedAt instanceof Date);
    const clearIndex = updates.findIndex((u) => u.table === issues && u.patch.assigneeAgentId === null);
    const assignIndex = updates.findIndex((u) => u.table === issues && u.patch.assigneeAgentId === "idle-agent");
    expect(releaseIndex).toBeGreaterThanOrEqual(0);
    expect(clearIndex).toBeGreaterThan(releaseIndex);
    expect(assignIndex).toBeGreaterThan(clearIndex);
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
