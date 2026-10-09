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
import { SWARM_CLAIM_WAKE_REASON, resolveSwarmClaimSettings } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  createSwarmClaimSweeper,
  type SwarmClaimSweeperDeps,
} from "../myrmidon/swarm-claim/sweep.js";
import { readSwarmQueueCounters } from "../myrmidon/swarm-claim/idle-queue.js";
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

  /** A live lease of another task: what makes an agent "loaded". */
  async function seedLiveClaim(companyId: string, agentId: string) {
    const issueId = await seedTask(companyId, { identifier: "TASK-LOAD", status: "in_progress" });
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
  function sweeper(wakeCalls: WakeCall[], settings: { idleWakeBatch?: number } = {}) {
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
    expect(wakeCalls[0]?.reason).toBe(SWARM_CLAIM_WAKE_REASON);
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

  it("gives the task to the least loaded agent of the role", async () => {
    const companyId = await seedCompany();
    const agentAId = await seedAgent(companyId, { name: "agent-a" });
    const agentBId = await seedAgent(companyId, { name: "agent-b" });
    const issueId = await seedTask(companyId);
    // agent-a is busy with a task that is not up for grabs (it is in progress).
    await seedLiveClaim(companyId, agentAId);

    const wakeCalls: WakeCall[] = [];
    const result = await sweeper(wakeCalls).sweep(NOW);

    expect(result.idleClaimed).toBe(1);
    const [task] = await db
      .select({ assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect([agentAId, agentBId]).toContain(task?.assigneeAgentId);
    expect(task?.assigneeAgentId).toBe(agentBId);
  });

  it("caps the pass by the stored batch", async () => {
    const companyId = await seedCompany();
    await seedAgent(companyId, { name: "agent-a" });
    await seedAgent(companyId, { name: "agent-b" });
    await seedTask(companyId, { identifier: "TASK-1" });
    await seedTask(companyId, { identifier: "TASK-2" });
    const wakeCalls: WakeCall[] = [];

    const result = await sweeper(wakeCalls, { idleWakeBatch: 1 }).sweep(NOW);

    expect(result.idleClaimed).toBe(1);
    expect(wakeCalls).toHaveLength(1);
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
});