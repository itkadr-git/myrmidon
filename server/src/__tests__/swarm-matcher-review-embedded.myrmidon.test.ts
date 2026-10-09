// server/src/__tests__/swarm-matcher-review-embedded.myrmidon.test.ts
//
// myrmidon(1.6.5 OPE-6608, second review, items 1 / 5 / 6 / 7 / 8 / 10): the
// matcher's guards against a real database.
//
//   1  the loop: a run ends, the task is still the agent's own `todo`, and the
//      agent is woken for it again at once (design §4.3: 100 runs, 246 M tokens);
//   5  the claim is one transaction, goes through the issues service, and a wake
//      that cannot be queued takes the assignment back;
//   6  `swarmEligible: false` filters on the live pass, the closed host gate
//      holds back the freed agent and the expired lease;
//   7  a lease with a wake in flight does not expire;
//   8  "has a live run" means a live run of THIS task;
//   10 the race of two free agents for one task.
//
// Neutral data only: company-a, agent-a, agent-b.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentCastes,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueClaims,
  issues,
} from "@paperclipai/db";
import { and, eq, isNull } from "drizzle-orm";
import { SWARM_MATCHED_WAKE_REASON, resolveSwarmClaimSettings } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createCasteDirectoryReader } from "../myrmidon/castes/directory.js";
import { cooldownMs, unmovedStreak } from "../myrmidon/swarm-claim/cooling.js";
import { matchFreedAgent } from "../myrmidon/swarm-claim/index.js";
import { matchAgent, matchCompany, type SwarmMatcherDeps } from "../myrmidon/swarm-claim/matcher.js";
import { createSwarmClaimSweeper, type SwarmClaimSweeperDeps } from "../myrmidon/swarm-claim/sweep.js";
import type { HostCpuGate, HostMemoryGate } from "../myrmidon/run-admission.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const NOW = new Date("2026-10-09T12:00:00.000Z");
const MIN = 60_000;
const baseSettings = resolveSwarmClaimSettings({ env: {} }).settings;

const openMemoryGate: HostMemoryGate = {
  state: "open",
  thresholdMb: null,
  availableMb: null,
  settlingRuns: 0,
  reason: null,
  heldSince: null,
};
const closedMemoryGate: HostMemoryGate = { ...openMemoryGate, state: "closed", reason: "test: floor closed" };
const openCpuGate: HostCpuGate = {
  state: "open",
  thresholdPercent: null,
  load1: null,
  cores: null,
  loadPercentPerCore: null,
  backgroundPercentPerCore: null,
  load15PercentPerCore: null,
  loadAboveBackgroundPercent: null,
  cpuBusyPercent: null,
  busyThresholdPercent: null,
  psiSomeAvg10: null,
  psiThresholdPercent: null,
  source: null,
  reason: null,
  heldSince: null,
};

// The pure rule of the cooling needs no database; its red side is the number
// the design fixes (§4.3: 30 min, doubling, capped at 24 h).
describe("cooling rule of a task (design §4.3)", () => {
  it("doubles the wait with every unmoved run in a row and caps it at 24 h", () => {
    expect(cooldownMs(0)).toBe(0);
    expect(cooldownMs(1)).toBe(30 * MIN);
    expect(cooldownMs(2)).toBe(60 * MIN);
    expect(cooldownMs(3)).toBe(120 * MIN);
    expect(cooldownMs(20)).toBe(24 * 60 * MIN);
  });

  it("counts only the unbroken run of unmoved finishes, newest first", () => {
    const at = NOW;
    expect(
      unmovedStreak([
        { status: "failed", livenessState: null, endedAt: at },
        { status: "succeeded", livenessState: "blocked", endedAt: at },
        { status: "succeeded", livenessState: "advanced", endedAt: at },
        { status: "failed", livenessState: null, endedAt: at },
      ]),
    ).toBe(2);
    // A success that advanced the task, or one with no verdict, is no streak.
    expect(unmovedStreak([{ status: "succeeded", livenessState: "completed", endedAt: at }])).toBe(0);
    expect(unmovedStreak([{ status: "succeeded", livenessState: null, endedAt: at }])).toBe(0);
    expect(unmovedStreak([{ status: "succeeded", livenessState: "plan_only", endedAt: at }])).toBe(1);
  });
});

describeEmbeddedPostgres("matcher guards of the second review", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-swarm-matcher-review-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueClaims);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(agentCastes);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Swarm Co",
      issuePrefix: `SR${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name = "agent-a") {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "idle",
      metadata: {},
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    });
    return agentId;
  }

  async function seedTask(companyId: string, identifier = "TASK-1", assigneeAgentId: string | null = null) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier,
      title: "ready task",
      status: "todo",
      priority: "medium",
      assigneeAgentId,
    });
    return issueId;
  }

  async function seedRun(
    companyId: string,
    agentId: string,
    issueId: string,
    overrides: { status: string; finishedAt?: Date | null; livenessState?: string | null },
  ) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      companyId,
      agentId,
      status: overrides.status,
      contextIssueId: issueId,
      contextSnapshot: { issueId },
      livenessState: overrides.livenessState ?? null,
      startedAt: overrides.finishedAt ? new Date(overrides.finishedAt.getTime() - MIN) : NOW,
      finishedAt: overrides.finishedAt ?? null,
    });
    return id;
  }

  /** A wake in flight for a task (what a start limit leaves in the queue). */
  async function seedWakeInFlight(companyId: string, agentId: string, issueId: string, status = "queued") {
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "assignment",
      reason: SWARM_MATCHED_WAKE_REASON,
      status,
      payload: { issueId },
      requestedAt: NOW,
    });
  }

  interface Wake {
    agentId: string;
    issueId: unknown;
  }

  function matcherDeps(
    wakes: Wake[],
    overrides: {
      wakeup?: SwarmMatcherDeps["heartbeat"]["wakeup"];
      casteDirectory?: SwarmMatcherDeps["casteDirectory"];
    } = {},
  ): SwarmMatcherDeps {
    return {
      db,
      heartbeat: {
        wakeup:
          overrides.wakeup ??
          (async (agentId: string, opts: { payload?: Record<string, unknown> | null }) => {
            wakes.push({ agentId, issueId: opts.payload?.issueId });
            return { id: randomUUID() };
          }),
      },
      settings: { ...baseSettings, enabled: true },
      hostGateOpen: true,
      now: NOW,
      casteDirectory: overrides.casteDirectory,
    } as unknown as SwarmMatcherDeps;
  }

  async function assigneeOf(issueId: string) {
    const [row] = await db.select({ assigneeAgentId: issues.assigneeAgentId }).from(issues).where(eq(issues.id, issueId));
    return row?.assigneeAgentId ?? null;
  }

  async function liveClaims(issueId: string) {
    return db
      .select({ id: issueClaims.id, agentId: issueClaims.agentId })
      .from(issueClaims)
      .where(and(eq(issueClaims.issueId, issueId), isNull(issueClaims.releasedAt)));
  }

  // -------------------------------------------------------------------------
  // Item 1: the loop on the release path.
  // -------------------------------------------------------------------------
  describe("the freed agent is not sent back to the task it just finished", () => {
    it("does not wake the agent for the issue whose run has just ended", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const issueId = await seedTask(companyId, "TASK-1", agentId);
      const wakes: Wake[] = [];

      const pair = await matchAgent(matcherDeps(wakes), agentId, { excludeIssueId: issueId });

      expect(pair).toBeNull();
      expect(wakes).toEqual([]);
      // Control: without the exclusion the same task is the agent's next wake.
      const again = await matchAgent(matcherDeps(wakes), agentId);
      expect(again?.issueId).toBe(issueId);
      expect(wakes).toEqual([{ agentId, issueId }]);
    });

    it("wakes nobody on its own task while idle pickup is switched off for the agent", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      await seedTask(companyId, "TASK-1", agentId);
      const wakes: Wake[] = [];

      const pair = await matchAgent(matcherDeps(wakes), agentId, { pickupAllowed: false });

      expect(pair).toBeNull();
      expect(wakes).toEqual([]);
    });

    it("spends the company wake allowance, and wakes nobody once it is spent", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const issueId = await seedTask(companyId, "TASK-1", agentId);
      // A queue task that must not be handed out on an allowance that is not there.
      const queued = await seedTask(companyId, "TASK-2");
      const wakes: Wake[] = [];
      const taken: string[] = [];

      const spent = await matchAgent(matcherDeps(wakes), agentId, {
        wakeBudget: { tryConsume: () => false },
      });
      expect(spent).toBeNull();
      expect(wakes).toEqual([]);
      expect(await assigneeOf(queued)).toBeNull();

      const allowed = await matchAgent(matcherDeps(wakes), agentId, {
        wakeBudget: {
          tryConsume: (company: string) => {
            taken.push(company);
            return true;
          },
        },
      });
      expect(allowed?.issueId).toBe(issueId);
      expect(taken).toEqual([companyId]);
    });

    it("lets a task that just failed cool down, and lifts the cooling on a change by somebody else", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const issueId = await seedTask(companyId, "TASK-1", agentId);
      const endedAt = new Date(NOW.getTime() - 2 * MIN);
      const runId = await seedRun(companyId, agentId, issueId, {
        status: "failed",
        finishedAt: endedAt,
        livenessState: "failed",
      });
      const wakes: Wake[] = [];

      // The run failed two minutes ago: the 30 min cooldown is on.
      expect(await matchAgent(matcherDeps(wakes), agentId)).toBeNull();
      expect(wakes).toEqual([]);

      // The activity of the failed run itself and the board's own writes are the
      // loop, not a change.
      await db.insert(activityLog).values({
        companyId,
        actorType: "agent",
        actorId: agentId,
        action: "issue.updated",
        entityType: "issue",
        entityId: issueId,
        agentId,
        runId,
        createdAt: new Date(NOW.getTime() - MIN),
      });
      await db.insert(activityLog).values({
        companyId,
        actorType: "system",
        actorId: "swarm_matcher",
        action: "issue.updated",
        entityType: "issue",
        entityId: issueId,
        createdAt: new Date(NOW.getTime() - MIN),
      });
      expect(await matchAgent(matcherDeps(wakes), agentId)).toBeNull();

      // A person comments after the run: the cooling is lifted at once.
      await db.insert(activityLog).values({
        companyId,
        actorType: "user",
        actorId: "user-a",
        action: "issue.comment_added",
        entityType: "issue",
        entityId: issueId,
        createdAt: new Date(NOW.getTime() - 30_000),
      });
      const lifted = await matchAgent(matcherDeps(wakes), agentId);
      expect(lifted?.issueId).toBe(issueId);
    });

    it("keeps a task that failed twice out for 60 minutes, then lets it back", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const issueId = await seedTask(companyId, "TASK-1", agentId);
      await seedRun(companyId, agentId, issueId, {
        status: "failed",
        finishedAt: new Date(NOW.getTime() - 40 * MIN),
      });
      await seedRun(companyId, agentId, issueId, {
        status: "failed",
        finishedAt: new Date(NOW.getTime() - 50 * MIN),
      });
      const wakes: Wake[] = [];

      // 40 minutes after the last of two failures: 60 min are not over yet.
      expect(await matchAgent(matcherDeps(wakes), agentId)).toBeNull();

      // A single failure that old (30 min cooldown) would already be over.
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.finishedAt, new Date(NOW.getTime() - 50 * MIN)));
      const back = await matchAgent(matcherDeps(wakes), agentId);
      expect(back?.issueId).toBe(issueId);
    });
  });

  // -------------------------------------------------------------------------
  // Item 5: one transaction, the issues service, a wake failure rolls back.
  // -------------------------------------------------------------------------
  describe("the claim is one unit with the wake", () => {
    it("assigns through the issues service: the audit trail carries the assignment", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const issueId = await seedTask(companyId);

      const result = await matchCompany(matcherDeps([]), companyId);

      expect(result.pairs).toHaveLength(1);
      expect(await assigneeOf(issueId)).toBe(agentId);
      const trail = await db
        .select({ action: activityLog.action, actorId: activityLog.actorId, details: activityLog.details })
        .from(activityLog)
        .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.updated")));
      expect(trail).toHaveLength(1);
      expect(trail[0]?.actorId).toBe("swarm_matcher");
      expect(trail[0]?.details?.assigneeAgentId).toBe(agentId);
    });

    it("takes the assignment and the lease back when the wake cannot be queued", async () => {
      const companyId = await seedCompany();
      await seedAgent(companyId);
      const issueId = await seedTask(companyId);

      const result = await matchCompany(
        matcherDeps([], {
          wakeup: async () => {
            throw new Error("wake layer is down");
          },
        }),
        companyId,
      );

      expect(result.pairs).toHaveLength(0);
      expect(result.unmatched).toBe(1);
      // Not "assigned, leased, and no run": the task is back in the queue as it was.
      expect(await assigneeOf(issueId)).toBeNull();
      expect(await liveClaims(issueId)).toEqual([]);
      const rolledBack = await db
        .select({ action: activityLog.action })
        .from(activityLog)
        .where(eq(activityLog.entityId, issueId));
      expect(rolledBack.map((row) => row.action)).not.toContain("issue.swarm_matched");
    });

    it("takes the assignment back when the admission queues no wake at all", async () => {
      const companyId = await seedCompany();
      await seedAgent(companyId);
      const issueId = await seedTask(companyId);

      const result = await matchCompany(matcherDeps([], { wakeup: async () => null }), companyId);

      expect(result.pairs).toHaveLength(0);
      expect(await assigneeOf(issueId)).toBeNull();
      expect(await liveClaims(issueId)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Item 6: the caste directory and the host gate on the live pass.
  // -------------------------------------------------------------------------
  describe("the caste directory and the host gate reach the live pass", () => {
    function freedPorts(overrides: { hostGateOpen?: () => boolean } = {}) {
      return {
        db,
        env: {},
        settings: {
          getGeneral: async () => ({ swarmClaim: { ...baseSettings, enabled: true } }),
          updateGeneral: async () => {
            throw new Error("not used");
          },
        },
        enqueueWakeup: async () => ({ id: randomUUID() }),
        castes: createCasteDirectoryReader(db),
        hostGateOpen: overrides.hostGateOpen ?? (() => true),
      } as unknown as Parameters<typeof matchFreedAgent>[0];
    }

    it("does not hand a task to an agent whose caste is switched off (swarmEligible: false)", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const issueId = await seedTask(companyId);
      const ports = freedPorts();

      // Control: the seeded directory keeps `engineer` eligible and the agent gets the task.
      const control = await matchFreedAgent(ports, agentId);
      expect(control.pair?.issueId).toBe(issueId);
      await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, issueId));
      await db.delete(issueClaims);
      await db.delete(agentWakeupRequests);

      await db
        .update(agentCastes)
        .set({ swarmEligible: false })
        .where(and(eq(agentCastes.companyId, companyId), eq(agentCastes.key, "engineer")));
      const result = await matchFreedAgent(ports, agentId);

      expect(result).toEqual({ enabled: true, pair: null });
      expect(await assigneeOf(issueId)).toBeNull();
      expect(await liveClaims(issueId)).toEqual([]);
    });

    it("pairs nothing for the freed agent while the host run admission is closed", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const issueId = await seedTask(companyId);

      const result = await matchFreedAgent(freedPorts({ hostGateOpen: () => false }), agentId);

      expect(result.pair).toBeNull();
      expect(await assigneeOf(issueId)).toBeNull();
    });

    function sweeper(options: { memoryGate: HostMemoryGate; wakes: Wake[] }) {
      return createSwarmClaimSweeper({
        db,
        intervalMs: 0,
        env: {},
        settings: {
          getGeneral: async () => ({ swarmClaim: { ...baseSettings, enabled: true } }),
        },
        castes: createCasteDirectoryReader(db),
        hostMemoryGate: () => options.memoryGate,
        hostCpuGate: () => openCpuGate,
        enqueueWakeup: async (agentId: string, opts: { payload?: Record<string, unknown> }) => {
          options.wakes.push({ agentId, issueId: opts.payload?.issueId });
          return { id: randomUUID() };
        },
      } as unknown as SwarmClaimSweeperDeps);
    }

    it("leaves an expired lease and its owner alone while the host gate is closed", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const issueId = await seedTask(companyId, "TASK-1", agentId);
      await db.insert(issueClaims).values({
        companyId,
        issueId,
        agentId,
        role: "engineer",
        runId: null,
        claimedAt: new Date(NOW.getTime() - 60 * MIN),
        heartbeatAt: new Date(NOW.getTime() - 60 * MIN),
        expiresAt: new Date(NOW.getTime() - MIN),
      });
      const wakes: Wake[] = [];

      const closed = await sweeper({ memoryGate: closedMemoryGate, wakes }).sweep(NOW);

      expect(closed.expiredReleased).toBe(0);
      expect(closed.idleSkippedReason).toBe("test: floor closed");
      expect(await assigneeOf(issueId)).toBe(agentId);
      expect(await liveClaims(issueId)).toHaveLength(1);
      expect(wakes).toEqual([]);

      // The gate opens: the same lease is now released and the task re-matched.
      const open = await sweeper({ memoryGate: openMemoryGate, wakes }).sweep(NOW);
      expect(open.expiredReleased).toBe(1);
      expect(wakes).toEqual([{ agentId, issueId }]);
    });

    it("the periodic pass does not pair a task to a caste switched off", async () => {
      const companyId = await seedCompany();
      await seedAgent(companyId);
      const issueId = await seedTask(companyId);
      // Seed the directory by one read, then switch the caste off.
      await createCasteDirectoryReader(db)(companyId);
      await db
        .update(agentCastes)
        .set({ swarmEligible: false })
        .where(and(eq(agentCastes.companyId, companyId), eq(agentCastes.key, "engineer")));
      const wakes: Wake[] = [];

      const result = await sweeper({ memoryGate: openMemoryGate, wakes }).sweep(NOW);

      expect(result.idleClaimed).toBe(0);
      expect(wakes).toEqual([]);
      expect(await assigneeOf(issueId)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Items 7 and 8: the expiry of a lease.
  // -------------------------------------------------------------------------
  describe("the expiry of a lease", () => {
    function sweeper(wakes: Wake[]) {
      return createSwarmClaimSweeper({
        db,
        intervalMs: 0,
        env: {},
        settings: {
          getGeneral: async () => ({ swarmClaim: { ...baseSettings, enabled: true } }),
        },
        hostMemoryGate: () => openMemoryGate,
        hostCpuGate: () => openCpuGate,
        enqueueWakeup: async (agentId: string, opts: { payload?: Record<string, unknown> }) => {
          wakes.push({ agentId, issueId: opts.payload?.issueId });
          return { id: randomUUID() };
        },
      } as unknown as SwarmClaimSweeperDeps);
    }

    async function seedExpiredLease(companyId: string, agentId: string, issueId: string) {
      await db.insert(issueClaims).values({
        companyId,
        issueId,
        agentId,
        role: "engineer",
        runId: null,
        claimedAt: new Date(NOW.getTime() - 60 * MIN),
        heartbeatAt: new Date(NOW.getTime() - 60 * MIN),
        expiresAt: new Date(NOW.getTime() - MIN),
      });
    }

    it("a lease with a wake in flight does not expire", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const issueId = await seedTask(companyId, "TASK-1", agentId);
      await seedExpiredLease(companyId, agentId, issueId);
      await seedWakeInFlight(companyId, agentId, issueId, "queued");
      const wakes: Wake[] = [];

      const result = await sweeper(wakes).sweep(NOW);

      // The start limit holds the wake in the queue; the owner stays, the lease stays.
      expect(result.expiredReleased).toBe(0);
      expect(await assigneeOf(issueId)).toBe(agentId);
      expect(await liveClaims(issueId)).toHaveLength(1);
      expect(wakes).toEqual([]);
    });

    it("a lease expires once the wake is gone, and the task goes back to the queue", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const issueId = await seedTask(companyId, "TASK-1", agentId);
      await seedExpiredLease(companyId, agentId, issueId);
      await seedWakeInFlight(companyId, agentId, issueId, "completed");

      const result = await sweeper([]).sweep(NOW);

      expect(result.expiredReleased).toBe(1);
    });

    it("a wake parked on an execution hold does not keep the lease alive", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const issueId = await seedTask(companyId, "TASK-1", agentId);
      await seedExpiredLease(companyId, agentId, issueId);
      await db.insert(agentWakeupRequests).values({
        companyId,
        agentId,
        source: "assignment",
        reason: SWARM_MATCHED_WAKE_REASON,
        status: "deferred_issue_execution",
        payload: { issueId, executionWait: { kind: "hold" } },
        requestedAt: NOW,
      });

      const result = await sweeper([]).sweep(NOW);

      expect(result.expiredReleased).toBe(1);
    });

    it("a live run of the agent on ANOTHER task does not keep this task's owner", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const stale = await seedTask(companyId, "TASK-STALE", agentId);
      const busy = await seedTask(companyId, "TASK-BUSY", agentId);
      await seedExpiredLease(companyId, agentId, stale);
      await seedRun(companyId, agentId, busy, { status: "running" });

      const result = await sweeper([]).sweep(NOW);

      expect(result.expiredReleased).toBe(1);
      // Nobody was working on the stale task: it is nobody's again.
      expect(await assigneeOf(stale)).toBeNull();
      expect(await assigneeOf(busy)).toBe(agentId);
    });

    it("a live run of the agent on THIS task keeps its owner", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const issueId = await seedTask(companyId, "TASK-1", agentId);
      await seedExpiredLease(companyId, agentId, issueId);
      await seedRun(companyId, agentId, issueId, { status: "running" });

      await sweeper([]).sweep(NOW);

      expect(await assigneeOf(issueId)).toBe(agentId);
    });
  });

  // -------------------------------------------------------------------------
  // Item 10: the race of two free agents for one task.
  // -------------------------------------------------------------------------
  describe("the race of two free agents", () => {
    it("gives one task to exactly one of two agents that ask for it at once", async () => {
      const companyId = await seedCompany();
      const first = await seedAgent(companyId, "agent-a");
      const second = await seedAgent(companyId, "agent-b");
      const issueId = await seedTask(companyId);
      const wakes: Wake[] = [];

      const [one, two] = await Promise.all([
        matchAgent(matcherDeps(wakes), first),
        matchAgent(matcherDeps(wakes), second),
      ]);

      const winners = [one, two].filter((pair) => pair !== null);
      expect(winners).toHaveLength(1);
      const owner = winners[0]!.agentId;
      expect([first, second]).toContain(owner);
      expect(await assigneeOf(issueId)).toBe(owner);
      expect(await liveClaims(issueId)).toEqual([expect.objectContaining({ agentId: owner })]);
      // One task, one wake: the loser started nothing.
      expect(wakes).toEqual([{ agentId: owner, issueId }]);
    });
  });
});
