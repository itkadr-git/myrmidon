// server/src/__tests__/swarm-matcher-load-embedded.myrmidon.test.ts
//
// myrmidon(1.6.6 SWARM-B): the matcher's load and capacity reading against a real
// database.
//
//   * load counts assigned `todo` (reserved) and `in_progress` tasks and live
//     leases, a task once - not only leases or an idle heartbeat;
//   * the ceiling holds: a full executor takes nothing, the task stays queued;
//   * a free executor is preferred to one that already carries seven tasks;
//   * two concurrent passes cannot push an executor over the ceiling;
//   * a paused executor and an executor held by a recorded quota failure are out
//     until the resume / the recorded reset; a fresh heartbeat does not re-admit them;
//   * a reviewer-caste agent never takes an engineer-caste task;
//   * a project task goes only to a member of the project (the gate of the project
//     membership contract); a projectless task stays open to the company.
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
  issueRelations,
  issues,
  projectMemberships,
  projects,
} from "@myrmidon/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { resolveSwarmClaimSettings } from "@myrmidon/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { matchCompany, matchIssue, openLoadByAgent, quotaHoldsByAgent, type SwarmMatcherDeps } from "../myrmidon/swarm-claim/matcher.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const NOW = new Date("2026-10-20T12:00:00.000Z");
const MIN = 60_000;
const baseSettings = resolveSwarmClaimSettings({ env: {} }).settings;

describeEmbeddedPostgres("matcher load and capacity", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-swarm-matcher-load-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueClaims);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(projectMemberships);
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
      name: "Swarm Co",
      issuePrefix: `SL${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
    });
    return companyId;
  }

  async function seedAgent(
    companyId: string,
    name: string,
    overrides: { id?: string; role?: string; status?: string; pausedAt?: Date | null; lastHeartbeatAt?: Date | null } = {},
  ) {
    const agentId = overrides.id ?? randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: overrides.role ?? "engineer",
      status: overrides.status ?? "idle",
      pausedAt: overrides.pausedAt ?? null,
      lastHeartbeatAt: overrides.lastHeartbeatAt ?? null,
      metadata: {},
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    });
    return agentId;
  }

  /** Two agent ids with `low` < `high`, so the old smallest-id tie-break is known. */
  function orderedIds() {
    const [low, high] = [randomUUID(), randomUUID()].sort() as [string, string];
    return { low, high };
  }

  let taskSeq = 0;
  async function seedTask(
    companyId: string,
    overrides: {
      assigneeAgentId?: string | null;
      status?: string;
      casteKey?: string | null;
      projectId?: string | null;
    } = {},
  ) {
    const issueId = randomUUID();
    taskSeq += 1;
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `TASK-${taskSeq}`,
      title: "task",
      status: overrides.status ?? "todo",
      priority: "medium",
      assigneeAgentId: overrides.assigneeAgentId ?? null,
      casteKey: overrides.casteKey ?? null,
      projectId: overrides.projectId ?? null,
    });
    return issueId;
  }

  async function seedLease(companyId: string, agentId: string, issueId: string) {
    await db.insert(issueClaims).values({
      companyId,
      issueId,
      agentId,
      role: "engineer",
      runId: null,
      origin: "auto_match",
      claimedAt: NOW,
      heartbeatAt: NOW,
      expiresAt: new Date(NOW.getTime() + 60 * MIN),
    });
  }

  async function seedFailedRun(
    companyId: string,
    agentId: string,
    overrides: {
      status?: string;
      errorCode?: string | null;
      error?: string | null;
      resultJson?: Record<string, unknown> | null;
      finishedAt?: Date;
      createdAt?: Date;
    },
  ) {
    const finishedAt = overrides.finishedAt ?? new Date(NOW.getTime() - 5 * MIN);
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      status: overrides.status ?? "failed",
      errorCode: overrides.errorCode ?? null,
      error: overrides.error ?? null,
      resultJson: overrides.resultJson ?? null,
      invocationSource: "automation",
      startedAt: new Date(finishedAt.getTime() - MIN),
      finishedAt,
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
    });
  }

  function deps(
    wakes: string[],
    overrides: { maxActiveTasks?: number | null; now?: Date } = {},
  ): SwarmMatcherDeps {
    return {
      db,
      heartbeat: {
        wakeup: async (agentId: string) => {
          wakes.push(agentId);
          return { id: randomUUID() };
        },
      },
      settings: {
        ...baseSettings,
        enabled: true,
        maxActiveTasks: overrides.maxActiveTasks === undefined ? 3 : overrides.maxActiveTasks,
      },
      hostGateOpen: true,
      now: overrides.now ?? NOW,
    } as unknown as SwarmMatcherDeps;
  }

  async function assigneeOf(issueId: string) {
    const [row] = await db.select({ a: issues.assigneeAgentId }).from(issues).where(eq(issues.id, issueId));
    return row?.a ?? null;
  }

  async function openTasksOf(agentId: string) {
    return db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.assigneeAgentId, agentId), inArray(issues.status, ["todo", "in_progress"])));
  }

  describe("load", () => {
    it("prefers a free engineer to one that already carries seven open tasks", async () => {
      const companyId = await seedCompany();
      const { low, high } = orderedIds();
      const busy = await seedAgent(companyId, "agent-busy", { id: low });
      const free = await seedAgent(companyId, "agent-free", { id: high });
      for (let i = 0; i < 4; i += 1) await seedTask(companyId, { assigneeAgentId: busy, status: "in_progress" });
      for (let i = 0; i < 3; i += 1) await seedTask(companyId, { assigneeAgentId: busy, status: "todo" });
      const task = await seedTask(companyId);
      const wakes: string[] = [];

      // No ceiling: only the preference decides. The busy agent has the smaller id.
      const result = await matchCompany(deps(wakes, { maxActiveTasks: null }), companyId);

      expect(result.pairs.map((pair) => pair.agentId)).toEqual([free]);
      expect(await assigneeOf(task)).toBe(free);
      expect(wakes).toEqual([free]);
    });

    it("counts reserved todo and in_progress tasks against the ceiling, not only leases", async () => {
      const companyId = await seedCompany();
      const agent = await seedAgent(companyId, "agent-a");
      await seedTask(companyId, { assigneeAgentId: agent, status: "todo" });
      await seedTask(companyId, { assigneeAgentId: agent, status: "todo" });
      await seedTask(companyId, { assigneeAgentId: agent, status: "in_progress" });
      const task = await seedTask(companyId);
      const wakes: string[] = [];

      const result = await matchCompany(deps(wakes, { maxActiveTasks: 3 }), companyId);

      expect(result.pairs).toEqual([]);
      expect(result.unmatched).toBe(1);
      expect(await assigneeOf(task)).toBeNull();
      expect(wakes).toEqual([]);
      const claims = await db.select().from(issueClaims).where(isNull(issueClaims.releasedAt));
      expect(claims).toHaveLength(0);
    });

    it("hands the task over once the executor is below the ceiling", async () => {
      const companyId = await seedCompany();
      const agent = await seedAgent(companyId, "agent-a");
      await seedTask(companyId, { assigneeAgentId: agent, status: "todo" });
      await seedTask(companyId, { assigneeAgentId: agent, status: "in_progress" });
      const task = await seedTask(companyId);
      const wakes: string[] = [];

      const result = await matchCompany(deps(wakes, { maxActiveTasks: 3 }), companyId);

      expect(result.pairs.map((pair) => pair.issueId)).toEqual([task]);
      expect(await assigneeOf(task)).toBe(agent);
    });

    it("ignores three assigned todo tasks held by open blockers and claims ready work", async () => {
      const companyId = await seedCompany();
      const agent = await seedAgent(companyId, "agent-with-blocked-todos");
      const blocker = await seedTask(companyId, { status: "in_progress" });
      const blockedTasks = await Promise.all(
        Array.from({ length: 3 }, () => seedTask(companyId, { assigneeAgentId: agent })),
      );
      await db.insert(issueRelations).values(
        blockedTasks.map((blockedIssueId) => ({
          companyId,
          issueId: blocker,
          relatedIssueId: blockedIssueId,
          type: "blocks" as const,
        })),
      );
      const readyTask = await seedTask(companyId);
      const unrelated = await seedTask(companyId, { assigneeAgentId: agent });
      await db.insert(issueRelations).values({
        companyId,
        issueId: blocker,
        relatedIssueId: unrelated,
        type: "blocks" as const,
      });
      const wakes: string[] = [];

      const blockedTaskIds = new Set(blockedTasks);
      expect((await openTasksOf(agent)).filter(({ id }) => blockedTaskIds.has(id))).toHaveLength(3);
      expect((await openTasksOf(agent)).some(({ id }) => id === unrelated)).toBe(true);
      expect((await openLoadByAgent(db, companyId)).get(agent) ?? 0).toBe(4);

      const result = await matchCompany(deps(wakes, { maxActiveTasks: 3 }), companyId);

      expect(result.pairs.map((pair) => pair.issueId)).toEqual([readyTask]);
      expect(result.pairs.map((pair) => pair.agentId)).toEqual([agent]);
      expect(await assigneeOf(readyTask)).toBe(agent);
      expect(wakes).toEqual([agent]);
      expect((await openLoadByAgent(db, companyId)).get(agent)).toBe(1);
    });

    it("does not event-claim a task with an open blocker", async () => {
      const companyId = await seedCompany();
      const agent = await seedAgent(companyId, "agent-blocked-event");
      const blocker = await seedTask(companyId, { status: "in_progress" });
      const blocked = await seedTask(companyId);
      await db.insert(issueRelations).values({
        companyId,
        issueId: blocker,
        relatedIssueId: blocked,
        type: "blocks",
      });
      const result = await matchIssue(deps([], { maxActiveTasks: 1 }), blocked);
      expect(result).toBeNull();
      expect(await assigneeOf(blocked)).toBeNull();
      expect(await openTasksOf(agent)).toHaveLength(0);
    });
    it("counts a task that is both assigned and leased once", async () => {
      const companyId = await seedCompany();
      const agent = await seedAgent(companyId, "agent-a");
      const own = await seedTask(companyId, { assigneeAgentId: agent, status: "todo" });
      await seedLease(companyId, agent, own);
      const task = await seedTask(companyId);
      const wakes: string[] = [];

      // Ceiling 2: one open task (assigned + leased) leaves room for one more.
      const result = await matchCompany(deps(wakes, { maxActiveTasks: 2 }), companyId);

      expect(result.pairs.map((pair) => pair.issueId)).toEqual([task]);
    });

    it("ignores done tasks and tasks in review", async () => {
      const companyId = await seedCompany();
      const agent = await seedAgent(companyId, "agent-a");
      await seedTask(companyId, { assigneeAgentId: agent, status: "done" });
      await seedTask(companyId, { assigneeAgentId: agent, status: "in_review" });
      await seedTask(companyId, { assigneeAgentId: agent, status: "blocked" });
      const task = await seedTask(companyId);

      const result = await matchCompany(deps([], { maxActiveTasks: 1 }), companyId);

      expect(result.pairs.map((pair) => pair.issueId)).toEqual([task]);
    });
  });

  describe("concurrent passes", () => {
    it("two passes on one executor with ceiling 1 assign exactly one task", async () => {
      const companyId = await seedCompany();
      const agent = await seedAgent(companyId, "agent-a");
      const t1 = await seedTask(companyId);
      const t2 = await seedTask(companyId);
      const wakes: string[] = [];

      const [first, second] = await Promise.all([
        matchIssue(deps(wakes, { maxActiveTasks: 1 }), t1),
        matchIssue(deps(wakes, { maxActiveTasks: 1 }), t2),
      ]);

      expect([first, second].filter(Boolean)).toHaveLength(1);
      expect(await openTasksOf(agent)).toHaveLength(1);
      expect(wakes).toEqual([agent]);
    });

    it("two company passes on one executor with ceiling 2 never exceed it", async () => {
      const companyId = await seedCompany();
      const agent = await seedAgent(companyId, "agent-a");
      for (let i = 0; i < 4; i += 1) await seedTask(companyId);

      await Promise.all([
        matchCompany(deps([], { maxActiveTasks: 2 }), companyId),
        matchCompany(deps([], { maxActiveTasks: 2 }), companyId),
        matchCompany(deps([], { maxActiveTasks: 2 }), companyId),
      ]);

      expect((await openTasksOf(agent)).length).toBeLessThanOrEqual(2);
    });
  });

  describe("pause and quota", () => {
    it("skips a paused executor (status or paused_at) until it is resumed", async () => {
      const companyId = await seedCompany();
      const { low, high } = orderedIds();
      await seedAgent(companyId, "agent-paused", { id: low, status: "idle", pausedAt: new Date(NOW.getTime() - MIN) });
      const free = await seedAgent(companyId, "agent-free", { id: high });
      const task = await seedTask(companyId);

      const result = await matchCompany(deps([]), companyId);

      expect(result.pairs.map((pair) => pair.agentId)).toEqual([free]);
      expect(await assigneeOf(task)).toBe(free);
    });

    it("a fresh heartbeat does not re-admit a paused executor", async () => {
      const companyId = await seedCompany();
      await seedAgent(companyId, "agent-paused", {
        status: "idle",
        pausedAt: new Date(NOW.getTime() - 60 * MIN),
        lastHeartbeatAt: NOW,
      });
      const task = await seedTask(companyId);

      const result = await matchCompany(deps([]), companyId);

      expect(result.pairs).toEqual([]);
      expect(await assigneeOf(task)).toBeNull();
    });

    it("holds an executor with a recorded quota failure until the recorded reset, then admits it", async () => {
      const companyId = await seedCompany();
      const { low, high } = orderedIds();
      const blocked = await seedAgent(companyId, "agent-quota", { id: low, lastHeartbeatAt: NOW });
      const free = await seedAgent(companyId, "agent-free", { id: high });
      await seedFailedRun(companyId, blocked, {
        errorCode: "provider_quota",
        error: "Individual quota reached",
        resultJson: { providerQuotaRetryNotBefore: new Date(NOW.getTime() + 30 * MIN).toISOString() },
      });
      const first = await seedTask(companyId);

      const during = await matchCompany(deps([], { now: NOW }), companyId);
      expect(during.pairs.map((pair) => pair.agentId)).toEqual([free]);
      expect(await assigneeOf(first)).toBe(free);

      // Past the recorded reset the same facts hold nothing.
      const second = await seedTask(companyId);
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, first));
      const after = await matchCompany(deps([], { now: new Date(NOW.getTime() + 31 * MIN) }), companyId);
      expect(after.pairs.map((pair) => pair.agentId)).toEqual([blocked]);
      expect(await assigneeOf(second)).toBe(blocked);
    });

    it("an unrelated transient failure does not blacklist an executor", async () => {
      const companyId = await seedCompany();
      const agent = await seedAgent(companyId, "agent-a");
      await seedFailedRun(companyId, agent, { errorCode: "adapter_failed", error: "connection reset by peer" });
      const task = await seedTask(companyId);

      const result = await matchCompany(deps([]), companyId);

      expect(result.pairs.map((pair) => pair.issueId)).toEqual([task]);
    });

    it("a succeeded run after the quota failure lifts the hold", async () => {
      const companyId = await seedCompany();
      const agent = await seedAgent(companyId, "agent-a");
      await seedFailedRun(companyId, agent, {
        errorCode: "provider_quota",
        error: "Individual quota reached",
        finishedAt: new Date(NOW.getTime() - 20 * MIN),
      });
      await seedFailedRun(companyId, agent, { status: "succeeded", finishedAt: new Date(NOW.getTime() - 5 * MIN) });
      const task = await seedTask(companyId);

      const result = await matchCompany(deps([]), companyId);

      expect(result.pairs.map((pair) => pair.issueId)).toEqual([task]);
    });

    it("holds an executor whose admission failure carries the individual-quota text", async () => {
      const companyId = await seedCompany();
      const agent = await seedAgent(companyId, "agent-a");
      await db.insert(agentWakeupRequests).values({
        companyId,
        agentId: agent,
        source: "assignment",
        reason: "issue_assigned",
        status: "failed",
        error: "Individual quota reached",
        requestedAt: new Date(NOW.getTime() - 10 * MIN),
        finishedAt: new Date(NOW.getTime() - 10 * MIN),
      });
      const task = await seedTask(companyId);

      const result = await matchCompany(deps([]), companyId);

      expect(result.pairs).toEqual([]);
      expect(await assigneeOf(task)).toBeNull();
    });

    it("reads the quota facts of the candidate agents only, and only what can still hold", async () => {
      const companyId = await seedCompany();
      const held = await seedAgent(companyId, "agent-held");
      const outside = await seedAgent(companyId, "agent-outside");
      const clean = await seedAgent(companyId, "agent-clean");
      const reset = new Date(NOW.getTime() + 30 * MIN);
      // A coded failure from three days ago whose recorded reset is still ahead holds.
      await seedFailedRun(companyId, held, {
        errorCode: "provider_quota",
        error: "Individual quota reached",
        resultJson: { providerQuotaRetryNotBefore: reset.toISOString() },
        finishedAt: new Date(NOW.getTime() - 3 * 24 * 60 * MIN),
        createdAt: new Date(NOW.getTime() - 3 * 24 * 60 * MIN),
      });
      // A failure of an agent that is not in the pass is not read.
      await seedFailedRun(companyId, outside, {
        errorCode: "provider_quota",
        error: "Individual quota reached",
        resultJson: { providerQuotaRetryNotBefore: reset.toISOString() },
        finishedAt: new Date(NOW.getTime() - 10 * MIN),
        createdAt: new Date(NOW.getTime() - 10 * MIN),
      });
      // Another failure kind and a clean agent hold nothing.
      await seedFailedRun(companyId, clean, { errorCode: "adapter_failed", error: "connection reset by peer" });

      const holds = await quotaHoldsByAgent(db, companyId, NOW, [held, clean]);

      expect([...holds.keys()]).toEqual([held]);
      expect(holds.get(held)?.getTime()).toBe(reset.getTime());
      expect((await quotaHoldsByAgent(db, companyId, NOW, [])).size).toBe(0);
    });
  });

  describe("caste and project", () => {
    it("never gives an engineer-caste task to a reviewer-caste agent", async () => {
      const companyId = await seedCompany();
      const { low, high } = orderedIds();
      await seedAgent(companyId, "agent-reviewer", { id: low, role: "reviewer" });
      const engineer = await seedAgent(companyId, "agent-engineer", { id: high, role: "engineer" });
      const task = await seedTask(companyId, { casteKey: "engineer" });

      const result = await matchCompany(deps([]), companyId);

      expect(result.pairs.map((pair) => pair.agentId)).toEqual([engineer]);
      expect(await assigneeOf(task)).toBe(engineer);
    });

    it("leaves an engineer-caste task queued when only a reviewer is free", async () => {
      const companyId = await seedCompany();
      await seedAgent(companyId, "agent-reviewer", { role: "reviewer" });
      const task = await seedTask(companyId, { casteKey: "engineer" });

      const result = await matchCompany(deps([]), companyId);

      expect(result.pairs).toEqual([]);
      expect(await assigneeOf(task)).toBeNull();
    });

    it("gives a project task only to a member of the project; a projectless task stays open", async () => {
      const companyId = await seedCompany();
      const { low, high } = orderedIds();
      const outsider = await seedAgent(companyId, "agent-outsider", { id: low });
      const member = await seedAgent(companyId, "agent-member", { id: high });
      const [project] = await db
        .insert(projects)
        .values({ companyId, name: "Project A", leadAgentId: member })
        .returning();
      const projectTask = await seedTask(companyId, { projectId: project!.id });

      const first = await matchCompany(deps([]), companyId);
      expect(first.pairs.map((pair) => pair.agentId)).toEqual([member]);
      expect(await assigneeOf(projectTask)).toBe(member);

      // With the member gone from the pool the outsider still gets nothing from the project...
      await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, projectTask));
      await db.update(agents).set({ status: "paused" }).where(eq(agents.id, member));
      const second = await matchCompany(deps([]), companyId);
      expect(second.pairs).toEqual([]);
      expect(await assigneeOf(projectTask)).toBeNull();

      // ...but a task with no project is open to the company, outsider included.
      const open = await seedTask(companyId);
      const third = await matchCompany(deps([]), companyId);
      expect(third.pairs.map((pair) => pair.agentId)).toEqual([outsider]);
      expect(await assigneeOf(open)).toBe(outsider);
    });
  });
});
