// server/src/myrmidon/swarm-claim/routing-unstaffed-caste.myrmidon.test.ts
// myrmidon(OPE-12846 IDLE-DISPATCH): a caste with no agents of its own used to
// hold its ready unassigned tasks hostage. The matcher builds its pools from
// `agents.role` (listIdleRolePairs), so an unstaffed caste never forms a pair;
// the routing predicate (`unassignedTaskRoutedToRole`) sent the task to that
// caste alone, and no dispatch path could ever reach it — free default-role
// agents starved while the queue was non-empty (a week of 12 devops tasks over
// two idle engineers). The fix routes an unstaffed caste's tasks to the default
// unassigned role, next to the caste-less tasks.
//
// The assertions ask the real SQL predicate on a real database: through the
// role queue read (`roleQueueRows`) and end-to-end through the matcher pass
// (`matchCompany`).

import { randomUUID } from "node:crypto";
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
  type Db,
  type EmbeddedPostgresTestDatabase,
} from "@myrmidon/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { resolveSwarmClaimSettings } from "@myrmidon/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { roleQueueRows } from "./queue.js";
import { matchCompany, type SwarmMatcherDeps } from "./matcher.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const NOW = new Date("2026-11-12T12:00:00.000Z");
const baseSettings = resolveSwarmClaimSettings({ env: {} }).settings;
describeEmbeddedPostgres("unstaffed caste routing fallback (OPE-12846)", () => {
  let db!: Db;
  let tempDb: EmbeddedPostgresTestDatabase | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-swarm-unstaffed-caste-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    // The matcher pass writes activity entries that reference the agents
    // (activity_log.agent_id FK); they go first.
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

  async function seedCompany(): Promise<string> {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: `UC${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
    });
    return companyId;
  }

  async function seedAgent(
    companyId: string,
    name: string,
    role: string,
    overrides: { status?: string } = {},
  ): Promise<string> {
    const agentId = randomUUID();
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
    overrides: { identifier?: string; casteKey?: string | null } = {},
  ): Promise<string> {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: overrides.identifier ?? "TASK-1",
      title: "ready task",
      status: "todo",
      priority: "medium",
      casteKey: overrides.casteKey ?? null,
    });
    return issueId;
  }

  function matcherDeps(): SwarmMatcherDeps {
    return {
      db,
      heartbeat: { wakeup: async () => ({ id: randomUUID() }) },
      settings: { ...baseSettings, enabled: true },
      hostGateOpen: true,
      now: NOW,
    } as unknown as SwarmMatcherDeps;
  }

  async function assigneeOf(issueId: string): Promise<string | null> {
    const [row] = await db
      .select({ assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, issueId));
    return row?.assigneeAgentId ?? null;
  }

  it("routes an unstaffed caste's ready task into the default role's queue and the matcher pairs it with a free engineer", async () => {
    const companyId = await seedCompany();
    const engineerId = await seedAgent(companyId, "engineer-a", "engineer");
    // The live shape of OPE-12846: devops tasks, zero devops agents.
    const devopsTask = await seedTask(companyId, { identifier: "TASK-DEVOPS", casteKey: "devops" });
    const bareTask = await seedTask(companyId, { identifier: "TASK-BARE" });

    // The devops task keeps its own routing (the caste queue still reads it)
    // AND additionally rides the default role's queue: with no devops agents
    // the pair for 'devops' never forms, so this second read is what makes the
    // task dispatchable at all.
    const engineerQueue = await roleQueueRows(db, companyId, "engineer");
    expect(new Set(engineerQueue.map((row) => row.issueId))).toEqual(
      new Set([devopsTask, bareTask]),
    );
    const devopsQueue = await roleQueueRows(db, companyId, "devops");
    expect(devopsQueue.map((row) => row.issueId)).toEqual([devopsTask]);

    // End to end: the matcher pairs the unstaffed caste's task with the free
    // engineer — the wake that used to never happen. One free agent takes one
    // task per pass; the queue order decides which one.
    const pass = await matchCompany(matcherDeps(), companyId);
    expect(pass.pairs).toHaveLength(1);
    expect(pass.unmatched).toBe(1);
    expect(pass.pairs[0]?.role).toBe("engineer");
    const taken = pass.pairs[0]!.issueId;
    expect(await assigneeOf(taken)).toBe(engineerId);
    expect(await assigneeOf(taken === devopsTask ? bareTask : devopsTask)).toBeNull();
  }, 60_000);

  it("a staffed caste keeps its exclusive claim: the default role does not take its tasks", async () => {
    const companyId = await seedCompany();
    await seedAgent(companyId, "engineer-a", "engineer");
    const devopsId = await seedAgent(companyId, "devops-a", "devops");
    const devopsTask = await seedTask(companyId, { identifier: "TASK-DEVOPS", casteKey: "devops" });

    const engineerQueue = await roleQueueRows(db, companyId, "engineer");
    expect(engineerQueue.map((row) => row.issueId)).toEqual([]);
    const devopsQueue = await roleQueueRows(db, companyId, "devops");
    expect(devopsQueue.map((row) => row.issueId)).toEqual([devopsTask]);

    const pass = await matchCompany(matcherDeps(), companyId);
    expect(pass.pairs).toEqual([{ issueId: devopsTask, agentId: devopsId, role: "devops", identifier: "TASK-DEVOPS" }]);
  }, 60_000);

  it("a caste whose every agent is terminated counts as unstaffed", async () => {
    const companyId = await seedCompany();
    await seedAgent(companyId, "engineer-a", "engineer");
    await seedAgent(companyId, "devops-old", "devops", { status: "terminated" });
    const devopsTask = await seedTask(companyId, { identifier: "TASK-DEVOPS", casteKey: "devops" });

    const engineerQueue = await roleQueueRows(db, companyId, "engineer");
    expect(engineerQueue.map((row) => row.issueId)).toEqual([devopsTask]);
    const devopsQueue = await roleQueueRows(db, companyId, "devops");
    expect(devopsQueue.map((row) => row.issueId)).toEqual([devopsTask]);

    const pass = await matchCompany(matcherDeps(), companyId);
    expect(pass.pairs).toHaveLength(1);
    expect(pass.pairs[0]?.role).toBe("engineer");
    expect(pass.pairs[0]?.issueId).toBe(devopsTask);
  }, 60_000);

  it("a paused agent still staffs its caste: the tasks wait instead of jumping to the default role", async () => {
    const companyId = await seedCompany();
    await seedAgent(companyId, "engineer-a", "engineer");
    await seedAgent(companyId, "devops-a", "devops", { status: "paused" });
    const devopsTask = await seedTask(companyId, { identifier: "TASK-DEVOPS", casteKey: "devops" });

    const engineerQueue = await roleQueueRows(db, companyId, "engineer");
    expect(engineerQueue.map((row) => row.issueId)).toEqual([]);
    const devopsQueue = await roleQueueRows(db, companyId, "devops");
    expect(devopsQueue.map((row) => row.issueId)).toEqual([devopsTask]);

    const pass = await matchCompany(matcherDeps(), companyId);
    expect(pass.pairs).toEqual([]);
    expect(await assigneeOf(devopsTask)).toBeNull();
  }, 60_000);
});
