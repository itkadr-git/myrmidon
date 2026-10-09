// server/src/__tests__/swarm-idle-claim-embedded.myrmidon.test.ts
//
// myrmidon(1.6.5 OPE-6608 SWARM-WAKE-FIX A/B/D): the idle pass of the swarm
// queues, against a real database.
//
// The 09.10 audit: seven days, 3259 `swarm_claim_queue` runs cancelled, zero
// unassigned tasks claimed. The pass used to *wake* an agent with the id of a
// task that belonged to nobody, and the run admission cancelled the run before
// its checkout, because the task's assignee (NULL) was not the agent the run
// carried. Part A moves the claim to the server: the task is assigned and
// leased first, and only then is its owner woken — with that assignment, never
// with "go and look for work". Part B picks the least loaded agent, so the head
// of the pool is not the same five rows on every pass. Part D caps the pass by
// the stored batch instead of the environment variable only.
//
// Neutral data only: company-a, agent-a, agent-b.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, agents, companies, createDb, issueClaims, issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  SWARM_CLAIM_WAKE_REASON,
  SWARM_MATCHED_WAKE_REASON,
  resolveSwarmClaimSettings,
} from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  createSwarmClaimSweeper,
  type SwarmClaimSweeperDeps,
} from "../myrmidon/swarm-claim/sweep.js";
import {
  matchAgent,
  matchCompany,
  matchIssue,
  type SwarmMatcherDeps,
} from "../myrmidon/swarm-claim/matcher.js";
import { readSwarmQueueCounters } from "../myrmidon/swarm-claim/matcher.js";
import type { HostCpuGate, HostMemoryGate } from "../myrmidon/run-admission.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * The admission gates as this test injects them. The idle pass only reads
 * `state` of each gate (an `open` gate holds nothing back); the remaining
 * fields exist for the logs of a closed gate.
 */
const openMemoryGate: HostMemoryGate = {
  state: "open",
  thresholdMb: null,
  availableMb: null,
  settlingRuns: 0,
  reason: null,
  heldSince: null,
};

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

/** One wake the pass enqueued, with the assignment the task carried at the time. */
interface WakeCall {
  agentId: string;
  issueId: string;
  reason: string | undefined;
  assigneeAtWake: string | null;
}

const NOW = new Date("2026-10-09T12:00:00.000Z");

/**
 * A complete stored `general.swarmClaim` value, built from the module's own
 * defaults so it always passes the schema. Normalization is strict: an
 * incomplete object counts as absent, the default switch is off and the pass
 * never runs — the trap this fixture exists to avoid.
 */
const baseSwarmClaimSettings = resolveSwarmClaimSettings({ env: {} }).settings;

describeEmbeddedPostgres("swarm idle queue claims on the server, then wakes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-swarm-idle-claim-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(agentWakeupRequests);
    await db.delete(issueClaims);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db
      .insert(companies)
      .values({
        id: companyId,
        name: "Swarm Co",
        issuePrefix: `SW${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      });
    return companyId;
  }

  async function seedAgent(
    companyId: string,
    overrides: { name?: string; status?: string; metadata?: Record<string, unknown> } = {},
  ) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: overrides.name ?? "agent-a",
      role: "engineer",
      status: overrides.status ?? "idle",
      metadata: overrides.metadata ?? {},
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    });
    return agentId;
  }

  async function seedTask(
    companyId: string,
    overrides: { identifier?: string; status?: string } = {},
  ) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: overrides.identifier ?? "TASK-1",
      title: "ready task",
      status: overrides.status ?? "todo",
      priority: "medium",
    });
    return issueId;
  }

  /**
   * A live lease of another task: what makes an agent "loaded".
   *
   * The load must sit in a *queue* status. The sweep releases every lease whose
   * task is no longer queued (`listClaimsOnNonQueueIssues`) in the pass before
   * the matcher runs, so an `in_progress` load left its holder free again and
   * the ceiling assertion was decided by the `agents.id` tie instead of by the
   * ceiling — the full server lane caught exactly that.
   */
  async function seedLiveClaim(companyId: string, agentId: string) {
    const issueId = await seedTask(companyId, { identifier: "TASK-LOAD", status: "todo" });
    await db.update(issues).set({ assigneeAgentId: agentId }).where(eq(issues.id, issueId));
    await db.insert(issueClaims).values({
      companyId,
      issueId,
      agentId,
      role: "engineer",
      runId: null,
      claimedAt: NOW,
      heartbeatAt: NOW,
      expiresAt: new Date(NOW.getTime() + 900_000),
    });
    return issueId;
  }

  /**
   * The sweeper with the swarm switched on and a faked sweep admission. The
   * settings read is the port fake every unit test of this module uses (the
   * resolution itself is pinned in settings.myrmidon.test.ts).
   */
  function sweeper(
    wakeCalls: WakeCall[],
    settings: { idleWakeBatch?: number; maxActiveTasks?: number } = {},
  ) {
    const deps = {
      db,
      intervalMs: 0,
      env: {},
      settings: {
        getGeneral: async () => ({
          swarmClaim: {
            ...baseSwarmClaimSettings,
            enabled: true,
            idleWakeBatch: settings.idleWakeBatch ?? 5,
            // The default ceiling is three tasks per agent; a test that needs
            // "this agent is already full" asks for a ceiling of one.
            ...(settings.maxActiveTasks !== undefined
              ? { maxActiveTasks: settings.maxActiveTasks }
              : {}),
          },
        }),
      },
      hostMemoryGate: () => openMemoryGate,
      hostCpuGate: () => openCpuGate,
      enqueueWakeup: async (
        agentId: string,
        opts: { reason?: string; contextSnapshot?: Record<string, unknown> },
      ) => {
        const issueId = String(opts.contextSnapshot?.issueId ?? "");
        const [row] = await db
          .select({ assigneeAgentId: issues.assigneeAgentId })
          .from(issues)
          .where(eq(issues.id, issueId));
        wakeCalls.push({
          agentId,
          issueId,
          reason: opts.reason,
          assigneeAtWake: row?.assigneeAgentId ?? null,
        });
        return { id: randomUUID() };
      },
    } as unknown as SwarmClaimSweeperDeps;
    return createSwarmClaimSweeper(deps);
  }

  it("assigns and leases a ready unassigned task, then wakes its new owner with it", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const issueId = await seedTask(companyId);
    const wakeCalls: WakeCall[] = [];

    const result = await sweeper(wakeCalls).sweep(NOW);

    // Part A: the claim happened on the server, in this pass.
    expect(result.idleClaimed).toBe(1);
    expect(result.idleWoken).toBe(1);
    const [task] = await db
      .select({ assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(task?.assigneeAgentId).toBe(agentId);
    const claimRows = await db
      .select({ issueId: issueClaims.issueId, agentId: issueClaims.agentId, releasedAt: issueClaims.releasedAt })
      .from(issueClaims)
      .where(eq(issueClaims.issueId, issueId));
    expect(claimRows).toHaveLength(1);
    expect(claimRows[0]?.agentId).toBe(agentId);
    expect(claimRows[0]?.releasedAt).toBeNull();

    // The task already belonged to the agent when the wake was enqueued: this
    // is the ordering that keeps the run admission from reading the wake as a
    // reassignment and cancelling the run before its checkout.
    expect(wakeCalls).toHaveLength(1);
    expect(wakeCalls[0]?.agentId).toBe(agentId);
    expect(wakeCalls[0]?.issueId).toBe(issueId);
    expect(wakeCalls[0]?.reason).toBe(SWARM_MATCHED_WAKE_REASON);
    expect(wakeCalls[0]?.assigneeAtWake).toBe(agentId);
  });

  it("wakes nobody when the role has no free agent", async () => {
    const companyId = await seedCompany();
    await seedAgent(companyId, { status: "paused" });
    const issueId = await seedTask(companyId);
    const wakeCalls: WakeCall[] = [];

    const result = await sweeper(wakeCalls).sweep(NOW);

    expect(result.idleWoken).toBe(0);
    expect(result.idleClaimed).toBe(0);
    expect(wakeCalls).toEqual([]);
    const [task] = await db
      .select({ assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(task?.assigneeAgentId).toBeNull();
    expect(await db.select({ id: issueClaims.id }).from(issueClaims)).toEqual([]);
  });

  it("keeps the task for a free peer when the agent is at its task ceiling", async () => {
    const companyId = await seedCompany();
    const agentAId = await seedAgent(companyId, { name: "agent-a" });
    const agentBId = await seedAgent(companyId, { name: "agent-b" });
    const issueId = await seedTask(companyId);
    // agent-a already holds a live lease and this instance allows one task per
    // agent, so agent-a is not a candidate and the task goes to its free peer.
    // Nothing rotates here (review item 4): the pool decides, and equal facts
    // give the same agent on every pass.
    await seedLiveClaim(companyId, agentAId);

    const wakeCalls: WakeCall[] = [];
    const result = await sweeper(wakeCalls, { maxActiveTasks: 1 }).sweep(NOW);

    expect(result.idleClaimed).toBe(1);
    const [task] = await db
      .select({ assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect([agentAId, agentBId]).toContain(task?.assigneeAgentId);
    expect(task?.assigneeAgentId).toBe(agentBId);
  });

  it("hands two ready tasks to the two free agents in one pass", async () => {
    const companyId = await seedCompany();
    const first = await seedAgent(companyId, { name: "agent-a" });
    const second = await seedAgent(companyId, { name: "agent-b" });
    await seedTask(companyId, { identifier: "TASK-1" });
    await seedTask(companyId, { identifier: "TASK-2" });
    const wakeCalls: WakeCall[] = [];

    const result = await sweeper(wakeCalls).sweep(NOW);

    // design §9 п.5: min(tasks, free agents) per pass. The batch cap of the old
    // idle pass is gone with the pass itself (review item 5) — the matcher hands
    // out every pairing it finds, one task per agent.
    expect(result.idleClaimed).toBe(2);
    expect(wakeCalls).toHaveLength(2);
    const assigned = await db
      .select({ assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.companyId, companyId));
    expect(assigned).toHaveLength(2);
    expect([first, second].every((id) => assigned.some((row) => row.assigneeAgentId === id))).toBe(true);
  });

  it("takes the task off an owner whose lease expired with no run, then re-matches it", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, { name: "agent-a" });
    const issueId = await seedTask(companyId);
    await db.update(issues).set({ assigneeAgentId: agentId }).where(eq(issues.id, issueId));
    await db.insert(issueClaims).values({
      companyId,
      issueId,
      agentId,
      role: "engineer",
      runId: null,
      claimedAt: new Date(NOW.getTime() - 3_600_000),
      heartbeatAt: new Date(NOW.getTime() - 3_600_000),
      // Expired, and no run of the agent is live: the task is nobody's again.
      expiresAt: new Date(NOW.getTime() - 60_000),
    });

    const wakeCalls: WakeCall[] = [];
    const result = await sweeper(wakeCalls).sweep(NOW);

    expect(result.expiredReleased).toBe(1);
    // The old pass woke the NEXT agent of the caste on a task that still
    // belonged to the previous one (the 3259 `reassigned` cancellations). Here
    // the task is taken off that owner first and matched again, so whoever is
    // woken really owns the task when its run starts (review item 2).
    expect(wakeCalls).toHaveLength(1);
    expect(wakeCalls[0]?.agentId).toBe(agentId);
    expect(wakeCalls[0]?.assigneeAtWake).toBe(agentId);
  });

  // Part D: the numbers the panel shows. They are read straight off the live
  // tables, so the panel cannot drift from the queue the operator watches.
  it("counts what is queued, what was taken and what died in the last hour", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    await seedTask(companyId, { identifier: "TASK-1" });
    await seedTask(companyId, { identifier: "TASK-2" });
    await seedTask(companyId, { identifier: "TASK-3" });
    await seedLiveClaim(companyId, agentId);
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "swarm_claim",
      reason: SWARM_CLAIM_WAKE_REASON,
      status: "skipped",
      requestedAt: new Date(NOW.getTime() - 10 * 60 * 1000),
    });
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "swarm_claim",
      reason: SWARM_CLAIM_WAKE_REASON,
      status: "skipped",
      // Two hours old: out of the window the panel counts.
      requestedAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000),
    });

    const counters = await readSwarmQueueCounters(db, { companyIds: [companyId], now: NOW });

    expect(counters).toEqual({
      queuedUnassigned: 3,
      claimedLastHour: 1,
      cancelledLastHour: 1,
    });
  });
describe("the board-side matcher (OPE-6608 A: a task meets a free agent)", () => {
    /** One wake the matcher posted, with the task it carried. */
    interface MatcherWake {
      agentId: string;
      reason: string | undefined;
      payloadIssueId: unknown;
      contextIssueId: unknown;
      idempotencyKey: unknown;
    }

    function matcher(
      wakes: MatcherWake[],
      overrides: { hostGateOpen?: boolean } = {},
    ): SwarmMatcherDeps {
      return {
        db,
        heartbeat: {
          wakeup: async (
            agentId: string,
            opts: {
              reason?: string | null;
              payload?: Record<string, unknown> | null;
              contextSnapshot?: Record<string, unknown>;
              idempotencyKey?: string | null;
            },
          ) => {
            wakes.push({
              agentId,
              reason: opts.reason ?? undefined,
              payloadIssueId: opts.payload?.issueId,
              contextIssueId: opts.contextSnapshot?.issueId,
              idempotencyKey: opts.idempotencyKey,
            });
            return { id: randomUUID() };
          },
        },
        settings: { ...baseSwarmClaimSettings, enabled: true },
        hostGateOpen: overrides.hostGateOpen ?? true,
        now: NOW,
      } as unknown as SwarmMatcherDeps;
    }

    it("hands a ready task to a free agent of its caste and wakes it with that task", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, { name: "agent-a" });
      const issueId = await seedTask(companyId, { identifier: "TASK-1" });
      const wakes: MatcherWake[] = [];

      const result = await matchCompany(matcher(wakes), companyId);

      expect(result.pairs).toEqual([
        { issueId, agentId, role: "engineer", identifier: "TASK-1" },
      ]);
      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(issue.assigneeAgentId).toBe(agentId);
      const claims = await db.select().from(issueClaims).where(eq(issueClaims.issueId, issueId));
      expect(claims).toHaveLength(1);
      expect(claims[0].agentId).toBe(agentId);
      expect(claims[0].releasedAt).toBeNull();
      // The wake carries the assignment: that is the run the old pass lost.
      expect(wakes).toEqual([
        {
          agentId,
          reason: SWARM_MATCHED_WAKE_REASON,
          payloadIssueId: issueId,
          contextIssueId: issueId,
          idempotencyKey: `swarm_matched:${issueId}`,
        },
      ]);
    });

    it("wakes nobody while the caste has no free agent", async () => {
      const companyId = await seedCompany();
      const paused = await seedAgent(companyId, { name: "agent-a", status: "paused" });
      const issueId = await seedTask(companyId, { identifier: "TASK-1" });
      const wakes: MatcherWake[] = [];

      const result = await matchCompany(matcher(wakes), companyId);

      expect(result.pairs).toHaveLength(0);
      expect(result.unmatched).toBe(1);
      expect(wakes).toHaveLength(0);
      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(issue.assigneeAgentId).toBeNull();
      expect(paused).toBeTruthy();
    });

    it("hands two ready tasks to two free agents in one pass", async () => {
      const companyId = await seedCompany();
      const first = await seedAgent(companyId, { name: "agent-a" });
      const second = await seedAgent(companyId, { name: "agent-b" });
      const taskOne = await seedTask(companyId, { identifier: "TASK-1" });
      const taskTwo = await seedTask(companyId, { identifier: "TASK-2" });

      const result = await matchCompany(matcher([]), companyId);

      expect(result.pairs).toHaveLength(2);
      expect(new Set(result.pairs.map((pair) => pair.agentId)).size).toBe(2);
      const rows = await db.select().from(issues).where(eq(issues.companyId, companyId));
      const byId = new Map(rows.map((row) => [row.id, row.assigneeAgentId]));
      expect([byId.get(taskOne), byId.get(taskTwo)].sort()).toEqual([first, second].sort());
    });

    it("picks the same agent when the scent scores are equal — no rotation", async () => {
      const companyId = await seedCompany();
      const ids = [
        await seedAgent(companyId, { name: "agent-a" }),
        await seedAgent(companyId, { name: "agent-b" }),
        await seedAgent(companyId, { name: "agent-c" }),
      ];
      const issueId = await seedTask(companyId, { identifier: "TASK-1" });

      const first = await matchCompany(matcher([]), companyId);
      expect(first.pairs).toHaveLength(1);
      expect(first.pairs[0].agentId).toBe([...ids].sort()[0]);

      // The same facts must give the same agent again, not the next in line.
      await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, issueId));
      await db.delete(issueClaims);
      const second = await matchCompany(matcher([]), companyId);
      expect(second.pairs[0]?.agentId).toBe(first.pairs[0]?.agentId);
    });

    it("matches nothing while the run admission of the host is closed", async () => {
      const companyId = await seedCompany();
      await seedAgent(companyId, { name: "agent-a" });
      const issueId = await seedTask(companyId, { identifier: "TASK-1" });
      const wakes: MatcherWake[] = [];

      const result = await matchCompany(matcher(wakes, { hostGateOpen: false }), companyId);

      expect(result.hostGateClosed).toBe(true);
      expect(result.pairs).toHaveLength(0);
      expect(wakes).toHaveLength(0);
      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(issue.assigneeAgentId).toBeNull();
    });

    it("matches one task on its own event and hands it to the free agent", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, { name: "agent-a" });
      const issueId = await seedTask(companyId, { identifier: "TASK-1" });

      const pair = await matchIssue(matcher([]), issueId);

      expect(pair).toEqual({ issueId, agentId, role: "engineer", identifier: "TASK-1" });
      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(issue.assigneeAgentId).toBe(agentId);
    });

    it("wakes the agent on its own assigned ready task before any queue task", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, { name: "agent-a" });
      const own = await seedTask(companyId, { identifier: "TASK-OWN" });
      const other = await seedTask(companyId, { identifier: "TASK-OTHER" });
      await db.update(issues).set({ assigneeAgentId: agentId }).where(eq(issues.id, own));

      const wakes: MatcherWake[] = [];
      const pair = await matchAgent(matcher(wakes), agentId);

      // Review item 3: an assigned, unrun task of the agent comes first — the
      // regression was that it was never offered to its own agent again.
      expect(pair?.issueId).toBe(own);
      expect(wakes).toHaveLength(1);
      expect(wakes[0]?.payloadIssueId).toBe(own);
      expect(other).toBeTruthy();
      const [row] = await db.select().from(issues).where(eq(issues.id, other));
      expect(row.assigneeAgentId).toBeNull();
    });

    it("hands the free agent the top of its queue on its own event", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, { name: "agent-a" });
      const low = await seedTask(companyId, { identifier: "TASK-LOW" });
      const high = await seedTask(companyId, { identifier: "TASK-HIGH" });
      await db.update(issues).set({ priority: "critical" }).where(eq(issues.id, high));

      const pair = await matchAgent(matcher([]), agentId);

      expect(pair?.issueId).toBe(high);
      const [row] = await db.select().from(issues).where(eq(issues.id, high));
      expect(row.assigneeAgentId).toBe(agentId);
      expect(low).toBeTruthy();
    });
  });});
