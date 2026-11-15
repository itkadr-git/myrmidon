// server/src/__tests__/swarm-spread-embedded.myrmidon.test.ts
//
// myrmidon(1.6.9 SWARM-SPREAD): engineer tasks spread across idle engineers,
// against a real database.
//
//   * three ready tasks and three free engineers: each task goes to its own engineer;
//   * a busy engineer is not handed a queue task by the freed-agent event while a
//     free colleague could take it;
//   * three ready tasks and one free engineer: the free one takes one, the rest wait,
//     and with no free colleague a loaded engineer still takes a task, as before.
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
  issueWorkProducts,
  issues,
  projectMemberships,
  projects,
} from "@myrmidon/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { DEFAULT_SWARM_MAX_ACTIVE_TASKS, resolveSwarmClaimSettings } from "@myrmidon/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { matchAgent, matchCompany, type SwarmMatcherDeps } from "../myrmidon/swarm-claim/matcher.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const NOW = new Date("2026-10-20T12:00:00.000Z");
const MIN = 60_000;
const baseSettings = resolveSwarmClaimSettings({ env: {} }).settings;

describeEmbeddedPostgres("matcher spreads engineer tasks", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-swarm-spread-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueClaims);
    await db.delete(issueWorkProducts);
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
    overrides: {
      maxActiveTasks?: number | null;
      now?: Date;
      casteDirectory?: SwarmMatcherDeps["casteDirectory"];
    } = {},
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
        maxActiveTasks:
          overrides.maxActiveTasks === undefined
            ? DEFAULT_SWARM_MAX_ACTIVE_TASKS
            : overrides.maxActiveTasks,
      },
      hostGateOpen: true,
      now: overrides.now ?? NOW,
      ...(overrides.casteDirectory ? { casteDirectory: overrides.casteDirectory } : {}),
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

  describe("spread", () => {
    it("gives each of three ready tasks to its own free engineer", async () => {
      const companyId = await seedCompany();
      const engineers = [await seedAgent(companyId, "agent-a"), await seedAgent(companyId, "agent-b"), await seedAgent(companyId, "agent-c")];
      const tasks = [await seedTask(companyId), await seedTask(companyId), await seedTask(companyId)];
      const wakes: string[] = [];

      const result = await matchCompany(deps(wakes), companyId);

      expect(result.pairs).toHaveLength(3);
      const owners = await Promise.all(tasks.map((id) => assigneeOf(id)));
      expect([...owners].sort()).toEqual([...engineers].sort());
      expect(new Set(wakes).size).toBe(3);
    });

    it("does not give a second task to a busy engineer through the freed-agent event while colleagues are idle", async () => {
      const companyId = await seedCompany();
      const { low, high } = orderedIds();
      const busy = await seedAgent(companyId, "agent-busy", { id: low });
      const idleA = await seedAgent(companyId, "agent-idle-a", { id: high });
      const idleB = await seedAgent(companyId, "agent-idle-b");
      await seedTask(companyId, { assigneeAgentId: busy, status: "in_progress" });
      const queued = [await seedTask(companyId), await seedTask(companyId)];
      const wakes: string[] = [];

      expect(await matchAgent(deps(wakes), busy, { explicit: true })).toBeNull();
      expect(await assigneeOf(queued[0]!)).toBeNull();
      expect(await assigneeOf(queued[1]!)).toBeNull();
      expect(wakes).toEqual([]);

      const first = await matchAgent(deps(wakes), idleA);
      const second = await matchAgent(deps(wakes), idleB);
      expect(first?.agentId).toBe(idleA);
      expect(second?.agentId).toBe(idleB);
      expect((await openTasksOf(busy)).length).toBe(1);
      expect((await openTasksOf(idleA)).length).toBe(1);
      expect((await openTasksOf(idleB)).length).toBe(1);
    });

    it("with one free engineer gives it one task and leaves the rest queued", async () => {
      const companyId = await seedCompany();
      const free = await seedAgent(companyId, "agent-free");
      const full = [await seedAgent(companyId, "agent-full-a"), await seedAgent(companyId, "agent-full-b")];
      for (const agentId of full) {
        await seedTask(companyId, { assigneeAgentId: agentId, status: "todo" });
        await seedTask(companyId, { assigneeAgentId: agentId, status: "in_progress" });
      }
      const tasks = [await seedTask(companyId), await seedTask(companyId), await seedTask(companyId)];
      const wakes: string[] = [];

      const result = await matchCompany(deps(wakes), companyId);

      expect(result.pairs).toHaveLength(1);
      expect(result.pairs[0]!.agentId).toBe(free);
      expect(result.unmatched).toBe(2);
      const owners = await Promise.all(tasks.map((id) => assigneeOf(id)));
      expect(owners.filter((owner) => owner === free)).toHaveLength(1);
      expect(owners.filter((owner) => owner === null)).toHaveLength(2);
      expect(wakes).toEqual([free]);
    });

    it("with no free colleague a loaded engineer still takes a task through the freed-agent event", async () => {
      const companyId = await seedCompany();
      const loaded = await seedAgent(companyId, "agent-loaded");
      const other = await seedAgent(companyId, "agent-other");
      await seedTask(companyId, { assigneeAgentId: loaded, status: "in_progress" });
      await seedTask(companyId, { assigneeAgentId: other, status: "in_progress" });
      const queued = await seedTask(companyId);
      const wakes: string[] = [];

      const pair = await matchAgent(deps(wakes), loaded, { explicit: true });

      expect(pair?.agentId).toBe(loaded);
      expect(await assigneeOf(queued)).toBe(loaded);
    });
  });
});
