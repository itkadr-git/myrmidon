// server/src/__tests__/swarm-matcher-pheromone-embedded.myrmidon.test.ts
//
// myrmidon(1.6.5 OPE-6608 × F-27 #1047 × F-26 T5 #1070): the board matcher hands
// out tasks by the rules it does not own, against a real database:
//
//   a  of two ready tasks of one caste the matcher hands out the one with the
//      higher EFFECTIVE pheromone (the queue reads' `swarmQueueOrderBy`) — the
//      matcher's own oldest-first read handed out the older one;
//   b  a task routed to another caste (`unassignedTaskRoutedToRole`: the task's
//      caste, then the project default, then the legacy `role:` label) is never
//      handed to an agent of this caste;
//   c  a task in its cooling window (`isIssueCoolingDown`, wake-task-guard.ts) is
//      not handed out, and is again once somebody changes it;
//   c' a task the matcher itself keeps handing out (its runs come from the
//      assignment path, `swarm_matched`) cools down too; a person's manual run
//      never starts a cooling;
//   d  the order the matcher walks is exactly `orderSwarmQueueCandidates` (the JS
//      twin of the order) over the same rows, with and without P0 preemption.
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
  projects,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import {
  DEFAULT_PHEROMONE_DYNAMICS,
  orderSwarmQueueCandidates,
  resolveSwarmClaimSettings,
} from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { isIssueCoolingDown, readSwarmSettings } from "../myrmidon/wake-task-guard.js";
import {
  listIdleRolePairs,
  matchAgent,
  matchCompany,
  type SwarmMatcherDeps,
} from "../myrmidon/swarm-claim/matcher.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const NOW = new Date("2026-10-09T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const baseSettings = resolveSwarmClaimSettings({ env: {} }).settings;

describeEmbeddedPostgres("matcher × pheromone order, caste routing and cooling", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-swarm-matcher-pheromone-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueClaims);
    await db.delete(issues);
    await db.delete(projects);
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
      name: "company-a",
      issuePrefix: `SP${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
    });
    return companyId;
  }

  async function seedAgent(
    companyId: string,
    name = "agent-a",
    role = "engineer",
    overrides: { id?: string; status?: string } = {},
  ) {
    const agentId = overrides.id ?? randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role,
      status: overrides.status ?? "idle",
      metadata: {},
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    });
    return agentId;
  }

  async function seedTask(
    companyId: string,
    overrides: {
      identifier?: string;
      priority?: string;
      pheromoneStrength?: number;
      createdAt?: Date;
      casteKey?: string | null;
      projectId?: string | null;
    } = {},
  ) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: overrides.identifier ?? "TASK-1",
      title: "ready task",
      status: "todo",
      priority: overrides.priority ?? "medium",
      pheromoneStrength: overrides.pheromoneStrength ?? 10,
      casteKey: overrides.casteKey ?? null,
      projectId: overrides.projectId ?? null,
      createdAt: overrides.createdAt ?? NOW,
    });
    return issueId;
  }

  /** A finished run of the task (`automation` is what the cooling rule reads). */
  async function seedFinishedRun(
    companyId: string,
    agentId: string,
    issueId: string,
    input: { status: string; finishedAt: Date; invocationSource?: string; wakeReason?: string },
  ) {
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: input.status,
      invocationSource: input.invocationSource ?? "on_demand",
      nativeIssueId: issueId,
      contextIssueId: issueId,
      contextSnapshot: input.wakeReason ? { issueId, wakeReason: input.wakeReason } : { issueId },
      startedAt: new Date(input.finishedAt.getTime() - MIN),
      finishedAt: input.finishedAt,
    });
  }

  function matcherDeps(
    overrides: Partial<Pick<SwarmMatcherDeps, "settings" | "heartbeat" | "isAgentAvailable">> = {},
  ): SwarmMatcherDeps {
    return {
      db,
      heartbeat: overrides.heartbeat ?? { wakeup: async () => ({ id: randomUUID() }) },
      isAgentAvailable: overrides.isAgentAvailable,
      // The matcher's activity (matches and rollbacks) lands in the real log.
      logActivity: async (input: {
        companyId: string;
        actorType: string;
        actorId: string;
        agentId: string;
        runId: string | null;
        action: string;
        entityType: string;
        entityId: string;
        details: Record<string, unknown>;
      }) => {
        await db.insert(activityLog).values({
          companyId: input.companyId,
          actorType: input.actorType,
          actorId: input.actorId,
          agentId: input.agentId,
          runId: input.runId,
          action: input.action,
          entityType: input.entityType,
          entityId: input.entityId,
          details: input.details,
        });
      },
      settings: overrides.settings ?? { ...baseSettings, enabled: true },
      hostGateOpen: true,
      now: NOW,
    } as unknown as SwarmMatcherDeps;
  }

  async function assigneeOf(issueId: string) {
    const [row] = await db.select({ assigneeAgentId: issues.assigneeAgentId }).from(issues).where(eq(issues.id, issueId));
    return row?.assigneeAgentId ?? null;
  }

  // (a) ----------------------------------------------------------------------
  it("of two ready tasks of one caste hands out the one with the higher effective pheromone", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    // The older task is weaker: the oldest-first read used to hand it out.
    const older = await seedTask(companyId, {
      identifier: "TASK-OLD",
      pheromoneStrength: 10,
      createdAt: new Date(NOW.getTime() - 2 * HOUR),
    });
    const stronger = await seedTask(companyId, { identifier: "TASK-STRONG", pheromoneStrength: 60 });

    const result = await matchCompany(matcherDeps(), companyId);

    expect(result.pairs.map((pair) => pair.issueId)).toEqual([stronger]);
    expect(await assigneeOf(stronger)).toBe(agentId);
    expect(await assigneeOf(older)).toBeNull();
  });

  it("the freed agent takes the stronger task too, and a task that keeps failing sinks below an equal one", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const failing = await seedTask(companyId, { identifier: "TASK-FAILING", pheromoneStrength: 30 });
    const clean = await seedTask(companyId, {
      identifier: "TASK-CLEAN",
      pheromoneStrength: 30,
      createdAt: new Date(NOW.getTime() + MIN),
    });
    // Two failed runs with no change after them: −2 × failPenalty. Not
    // `automation` runs, so the cooling stays out of this case.
    await seedFinishedRun(companyId, agentId, failing, { status: "failed", finishedAt: new Date(NOW.getTime() - 3 * HOUR) });
    await seedFinishedRun(companyId, agentId, failing, { status: "failed", finishedAt: new Date(NOW.getTime() - 2 * HOUR) });

    const pair = await matchAgent(matcherDeps(), agentId);

    expect(pair?.issueId).toBe(clean);
    expect(await assigneeOf(failing)).toBeNull();
  });

  // (b) ----------------------------------------------------------------------
  it("never hands a task routed to another caste to an agent of this caste", async () => {
    const companyId = await seedCompany();
    const engineer = await seedAgent(companyId, "agent-a", "engineer");
    const [nest] = await db
      .insert(projects)
      .values({ companyId, name: "review nest", defaultCasteKey: "reviewer" })
      .returning();
    const ownCaste = await seedTask(companyId, { identifier: "TASK-REVIEW", casteKey: "reviewer", pheromoneStrength: 90 });
    const nestDefault = await seedTask(companyId, { identifier: "TASK-NEST", projectId: nest!.id, pheromoneStrength: 90 });

    expect(await matchAgent(matcherDeps(), engineer)).toBeNull();
    const pass = await matchCompany(matcherDeps(), companyId);
    expect(pass.pairs).toEqual([]);
    expect(await assigneeOf(ownCaste)).toBeNull();
    expect(await assigneeOf(nestDefault)).toBeNull();

    // Control: an agent of the caste the tasks are routed to takes them.
    const reviewer = await seedAgent(companyId, "agent-b", "reviewer");
    const taken = await matchAgent(matcherDeps(), reviewer);
    expect([ownCaste, nestDefault]).toContain(taken?.issueId);
    expect(await assigneeOf(taken!.issueId)).toBe(reviewer);
  });

  // (c) ----------------------------------------------------------------------
  it("does not hand out a task in its cooling window, and does once somebody changes it", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const issueId = await seedTask(companyId);
    // An automatic run of the task failed two minutes ago: the first window
    // (30 min by default) is on.
    await seedFinishedRun(companyId, agentId, issueId, {
      status: "failed",
      finishedAt: new Date(NOW.getTime() - 2 * MIN),
      invocationSource: "automation",
    });

    const cooling = await matchCompany(matcherDeps(), companyId);
    expect(cooling.pairs).toEqual([]);
    expect(cooling.unmatched).toBe(1);
    expect(await matchAgent(matcherDeps(), agentId)).toBeNull();
    expect(await assigneeOf(issueId)).toBeNull();

    // A person comments on the task: the cooling is lifted at once.
    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "user-a",
      action: "issue.comment_added",
      entityType: "issue",
      entityId: issueId,
      createdAt: new Date(NOW.getTime() - MIN),
    });
    const lifted = await matchCompany(matcherDeps(), companyId);
    expect(lifted.pairs.map((pair) => pair.issueId)).toEqual([issueId]);
    expect(await assigneeOf(issueId)).toBe(agentId);
  });

  // (c') ---------------------------------------------------------------------
  it("a task the matcher keeps handing out cools down after two failed matched runs; manual runs never cool a task", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const settings = await readSwarmSettings(db);
    // The matcher woke the agent twice through the assignment path and both
    // runs failed (40 and 50 minutes ago): two stale runs = a 60-minute window.
    // Red side: a filter on `invocation_source = 'automation'` alone never saw
    // these runs, and the matcher handed the task out a third time.
    const matched = await seedTask(companyId, { identifier: "TASK-MATCHED", pheromoneStrength: 90 });
    for (const minutesAgo of [50, 40]) {
      await seedFinishedRun(companyId, agentId, matched, {
        status: "failed",
        finishedAt: new Date(NOW.getTime() - minutesAgo * MIN),
        invocationSource: "assignment",
        wakeReason: "swarm_matched",
      });
    }
    // Control: the same two failures, but from a person's manual wakes.
    const manual = await seedTask(companyId, { identifier: "TASK-MANUAL", pheromoneStrength: 10 });
    for (const minutesAgo of [50, 40]) {
      await seedFinishedRun(companyId, agentId, manual, {
        status: "failed",
        finishedAt: new Date(NOW.getTime() - minutesAgo * MIN),
        invocationSource: "on_demand",
        wakeReason: "manual",
      });
    }

    const matchedStatus = await isIssueCoolingDown(db, companyId, matched, settings, NOW);
    expect(matchedStatus.cooling).toBe(true);
    expect(matchedStatus.staleCount).toBe(2);
    expect((await isIssueCoolingDown(db, companyId, manual, settings, NOW)).cooling).toBe(false);

    // The stronger task is cooling: the pass hands out the manual one instead.
    const result = await matchCompany(matcherDeps(), companyId);
    expect(result.pairs.map((pair) => pair.issueId)).toEqual([manual]);
    expect(await assigneeOf(matched)).toBeNull();
    expect(await assigneeOf(manual)).toBe(agentId);
  });

  // Pool health (ADM review of 18a69ff91) ------------------------------------
  async function rollbacks(issueId: string) {
    return db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.swarm_matched_rolled_back")));
  }

  it("an agent the wake layer refuses never enters the pool: the task goes to the healthy agent at once, a second pass writes no rollback", async () => {
    const companyId = await seedCompany();
    // The smallest id wins a tie: before the fix this agent took the top task
    // on every pass, its wake was refused and the pairing rolled back.
    const pending = await seedAgent(companyId, "agent-a", "engineer", {
      id: "00000000-0000-4000-8000-000000000001",
      status: "pending_approval",
    });
    const healthy = await seedAgent(companyId, "agent-b", "engineer", { id: "ffffffff-ffff-4fff-8fff-ffffffffffff" });
    const issueId = await seedTask(companyId);
    const woken: string[] = [];
    const heartbeat = {
      wakeup: async (agentId: string) => {
        woken.push(agentId);
        if (agentId === pending) throw Object.assign(new Error("Agent is not invokable"), { status: 409 });
        return { id: randomUUID() };
      },
    } as unknown as SwarmMatcherDeps["heartbeat"];

    const first = await matchCompany(matcherDeps({ heartbeat }), companyId);
    expect(first.pairs.map((pair) => pair.agentId)).toEqual([healthy]);
    expect(await assigneeOf(issueId)).toBe(healthy);
    expect(woken).toEqual([healthy]);

    const second = await matchCompany(matcherDeps({ heartbeat }), companyId);
    expect(second.pairs).toEqual([]);
    expect(woken).toEqual([healthy]);
    expect(await rollbacks(issueId)).toEqual([]);
  });

  it("an agent a gate keeps out (maintenance, budget) is not paired; a refused wake hands the same task to the next agent", async () => {
    const companyId = await seedCompany();
    const blocked = await seedAgent(companyId, "agent-a", "engineer", { id: "00000000-0000-4000-8000-000000000002" });
    const healthy = await seedAgent(companyId, "agent-b", "engineer", { id: "ffffffff-ffff-4fff-8fff-fffffffffff2" });
    const gated = await seedTask(companyId, { identifier: "TASK-GATED" });

    // The availability port says no: the agent is not in the pool at all.
    const viaGate = await matchCompany(
      matcherDeps({ isAgentAvailable: async ({ agentId }) => agentId !== blocked }),
      companyId,
    );
    expect(viaGate.pairs.map((pair) => pair.agentId)).toEqual([healthy]);
    expect(await rollbacks(gated)).toEqual([]);

    // A wake refused anyway (the gate changed between the read and the wake):
    // the same task goes to the next agent in the same pass.
    const refused = await seedTask(companyId, { identifier: "TASK-REFUSED" });
    await db.delete(issueClaims);
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, gated));
    const heartbeat = {
      wakeup: async (agentId: string) => {
        if (agentId === blocked) throw Object.assign(new Error("budget blocked"), { status: 409 });
        return { id: randomUUID() };
      },
    } as unknown as SwarmMatcherDeps["heartbeat"];
    const retried = await matchCompany(matcherDeps({ heartbeat, isAgentAvailable: async () => true }), companyId);
    expect(retried.pairs.map((pair) => [pair.issueId, pair.agentId])).toEqual([[refused, healthy]]);
    expect(await assigneeOf(refused)).toBe(healthy);
    expect(await rollbacks(refused)).toHaveLength(1);
  });

  it("a task whose project budget blocks it is skipped; the next task of the caste goes out, with no rollback on the first", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const [paused] = await db
      .insert(projects)
      .values({ companyId, name: "spent nest", pausedAt: NOW, pauseReason: "budget" })
      .returning();
    // The top task of the caste sits in the project whose budget is spent.
    const blocked = await seedTask(companyId, { identifier: "TASK-SPENT", pheromoneStrength: 90, projectId: paused!.id });
    const next = await seedTask(companyId, { identifier: "TASK-NEXT", pheromoneStrength: 10 });
    // The wake layer refuses a run on the blocked project, as heartbeat does.
    const heartbeat = {
      wakeup: async (_agentId: string, opts: { payload?: Record<string, unknown> | null }) => {
        if (opts.payload?.issueId === blocked) {
          throw Object.assign(new Error("Project is paused because its budget hard-stop was reached."), { status: 409 });
        }
        return { id: randomUUID() };
      },
    } as unknown as SwarmMatcherDeps["heartbeat"];

    // Red side: the refused wake used to mark the only agent failed, the pool
    // emptied, and the next task waited behind the blocked one on every pass.
    const pass = await matchCompany(matcherDeps({ heartbeat }), companyId);
    expect(pass.pairs.map((pair) => pair.issueId)).toEqual([next]);
    expect(await assigneeOf(next)).toBe(agentId);
    expect(await assigneeOf(blocked)).toBeNull();
    expect(await rollbacks(blocked)).toEqual([]);
    expect(await db.select({ id: issueClaims.id }).from(issueClaims).where(eq(issueClaims.issueId, blocked))).toEqual([]);
  });

  // (d) ----------------------------------------------------------------------
  it("walks the queue in exactly the order orderSwarmQueueCandidates gives the same rows", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const tasks = [
      await seedTask(companyId, { identifier: "T-1", priority: "medium", pheromoneStrength: 10, createdAt: new Date(NOW.getTime() - 80 * HOUR) }),
      await seedTask(companyId, { identifier: "T-2", priority: "medium", pheromoneStrength: 12 }),
      await seedTask(companyId, { identifier: "T-3", priority: "high", pheromoneStrength: 5, createdAt: new Date(NOW.getTime() - HOUR) }),
      await seedTask(companyId, { identifier: "T-4", priority: "low", pheromoneStrength: 100, createdAt: new Date(NOW.getTime() - 30 * HOUR) }),
      await seedTask(companyId, { identifier: "T-5", priority: "critical", pheromoneStrength: 1, createdAt: new Date(NOW.getTime() - 5 * MIN) }),
      await seedTask(companyId, { identifier: "T-6", priority: "medium", pheromoneStrength: 30, createdAt: new Date(NOW.getTime() - 10 * HOUR) }),
    ];
    // T-6 failed twice with no change since: 30 − 2 × 10.
    await seedFinishedRun(companyId, agentId, tasks[5]!, { status: "failed", finishedAt: new Date(NOW.getTime() - 4 * HOUR) });
    await seedFinishedRun(companyId, agentId, tasks[5]!, { status: "timed_out", finishedAt: new Date(NOW.getTime() - 3 * HOUR) });

    for (const p0Preemption of [true, false]) {
      const order = { p0Preemption, dynamics: DEFAULT_PHEROMONE_DYNAMICS, now: NOW };
      const pairs = await listIdleRolePairs(db, companyId, { order });
      const queue = pairs.find((pair) => pair.role === "engineer")?.queue ?? [];
      expect(new Set(queue.map((row) => row.issueId))).toEqual(new Set(tasks));
      const jsOrder = orderSwarmQueueCandidates(queue, order).map((row) => row.issueId);
      expect(queue.map((row) => row.issueId), `p0Preemption=${p0Preemption}`).toEqual(jsOrder);
      // The two ends of the contract: the P0 task leads only while it preempts.
      expect(jsOrder[0] === tasks[4]).toBe(p0Preemption);
    }

    // And the pass hands the single free agent the top of that order.
    const settings = { ...baseSettings, enabled: true, p0Preemption: false };
    const pairs = await listIdleRolePairs(db, companyId, {
      order: { p0Preemption: false, dynamics: DEFAULT_PHEROMONE_DYNAMICS, now: NOW },
    });
    const top = pairs.find((pair) => pair.role === "engineer")?.queue[0]?.issueId;
    const result = await matchCompany(matcherDeps({ settings }), companyId);
    expect(result.pairs.map((pair) => pair.issueId)).toEqual([top]);
  });
});
