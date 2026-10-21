// server/src/__tests__/swarm-project-scope-embedded.myrmidon.test.ts
//
// myrmidon(1.6.6 PROJECT-SCOPED-CLAIM, OPE-7278): automatic task taking is
// project-scoped, against a real database.
//
// The rule: a task that carries a project is taken automatically only by a
// member of that project (its lead, or a joined `project_memberships` row whose
// user id is an agent of the same company); a task without a project stays open
// to the company. Pinned at the three seams that hand a task out: the matcher
// (event of a ready task / of a free agent), the claim API's role queue, and
// idle pickup's roster twin `listAgentProjectIds`.
//
// Neutral data only: outsider-eng (the bbq-* side) and member-eng (the
// adm-dev-eng-* side).

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentNests,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueClaims,
  issues,
  projectMemberships,
  projects,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { resolveSwarmClaimSettings } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { matchAgent, matchIssue, type SwarmMatcherDeps } from "../myrmidon/swarm-claim/matcher.js";
import { listRoleQueue } from "../myrmidon/swarm-claim/queue.js";
import { listAgentProjectIds } from "../myrmidon/project-membership.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const NOW = new Date("2026-10-21T12:00:00.000Z");
const baseSwarmClaimSettings = resolveSwarmClaimSettings({ env: {} }).settings;

// Fixed ids: the outsider sorts BEFORE the member, so a scope that did not
// hold would hand the task to the outsider (the matcher's tie-break is the
// smallest agent id).
const OUTSIDER_ID = "00000000-0000-4000-8000-0000000000a1";
const MEMBER_ID = "ffffffff-0000-4000-8000-0000000000b2";

describeEmbeddedPostgres("project-scoped automatic claim", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-project-scope-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueClaims);
    await db.delete(issues);
    await db.delete(agentNests);
    await db.delete(projectMemberships);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Scope Co",
      issuePrefix: `SC${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, id: string, name: string) {
    await db.insert(agents).values({
      id,
      companyId,
      name,
      role: "engineer",
      status: "idle",
      metadata: {},
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    });
    return id;
  }

  async function seedProject(companyId: string, leadAgentId: string | null = null) {
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Tools",
      status: "in_progress",
      leadAgentId,
    });
    return projectId;
  }

  async function join(companyId: string, projectId: string, userId: string, state = "joined") {
    await db.insert(projectMemberships).values({ companyId, projectId, userId, state });
  }

  async function nest(companyId: string, projectId: string, agentId: string) {
    await db.insert(agentNests).values({ companyId, projectId, agentId });
  }

  async function seedTask(companyId: string, identifier: string, projectId: string | null) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      identifier,
      title: identifier,
      status: "todo",
      priority: "medium",
    });
    return issueId;
  }

  function matcher(): SwarmMatcherDeps {
    return {
      db,
      heartbeat: { wakeup: async () => ({ id: randomUUID() }) },
      settings: { ...baseSwarmClaimSettings, enabled: true },
      hostGateOpen: true,
      now: NOW,
    } as unknown as SwarmMatcherDeps;
  }

  async function assigneeOf(issueId: string) {
    const [row] = await db
      .select({ assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eqId(issueId));
    return row?.assigneeAgentId ?? null;
  }

  function eqId(issueId: string) {
    return eq(issues.id, issueId);
  }

  it("hands a project task to a joined member, never to the non-member that sorts first", async () => {
    const companyId = await seedCompany();
    await seedAgent(companyId, OUTSIDER_ID, "outsider-eng");
    await seedAgent(companyId, MEMBER_ID, "member-eng");
    const projectId = await seedProject(companyId);
    await join(companyId, projectId, MEMBER_ID);
    const issueId = await seedTask(companyId, "TASK-1", projectId);

    const pair = await matchIssue(matcher(), issueId);

    expect(pair?.agentId).toBe(MEMBER_ID);
    expect(await assigneeOf(issueId)).toBe(MEMBER_ID);
  });

  it("leaves a project task unassigned when only non-members are free", async () => {
    const companyId = await seedCompany();
    await seedAgent(companyId, OUTSIDER_ID, "outsider-eng");
    const projectId = await seedProject(companyId);
    const issueId = await seedTask(companyId, "TASK-1", projectId);

    expect(await matchIssue(matcher(), issueId)).toBeNull();
    expect(await assigneeOf(issueId)).toBeNull();
  });

  it("counts the project lead as a member, and ignores a left membership", async () => {
    const companyId = await seedCompany();
    await seedAgent(companyId, OUTSIDER_ID, "outsider-eng");
    await seedAgent(companyId, MEMBER_ID, "lead-eng");
    const projectId = await seedProject(companyId, MEMBER_ID);
    await join(companyId, projectId, OUTSIDER_ID, "left");
    const issueId = await seedTask(companyId, "TASK-1", projectId);

    const pair = await matchIssue(matcher(), issueId);

    expect(pair?.agentId).toBe(MEMBER_ID);
  });

  it("a free non-member takes a projectless task but skips the project task above it", async () => {
    const companyId = await seedCompany();
    await seedAgent(companyId, OUTSIDER_ID, "outsider-eng");
    const projectId = await seedProject(companyId);
    const scoped = await seedTask(companyId, "TASK-SCOPED", projectId);
    const open = await seedTask(companyId, "TASK-OPEN", null);
    // The project task is the older one, so without the scope it would win.

    const pair = await matchAgent(matcher(), OUTSIDER_ID);

    expect(pair?.issueId).toBe(open);
    expect(await assigneeOf(scoped)).toBeNull();
  });

  it("a free member takes the project task on its own event", async () => {
    const companyId = await seedCompany();
    await seedAgent(companyId, MEMBER_ID, "member-eng");
    const projectId = await seedProject(companyId);
    await join(companyId, projectId, MEMBER_ID);
    const scoped = await seedTask(companyId, "TASK-SCOPED", projectId);

    const pair = await matchAgent(matcher(), MEMBER_ID);

    expect(pair?.issueId).toBe(scoped);
  });

  it("the claim API's role queue shows a project task only to a member", async () => {
    const companyId = await seedCompany();
    await seedAgent(companyId, OUTSIDER_ID, "outsider-eng");
    await seedAgent(companyId, MEMBER_ID, "member-eng");
    const projectId = await seedProject(companyId);
    await join(companyId, projectId, MEMBER_ID);
    const scoped = await seedTask(companyId, "TASK-SCOPED", projectId);
    const open = await seedTask(companyId, "TASK-OPEN", null);

    const outsiderQueue = await listRoleQueue(db, companyId, "engineer", OUTSIDER_ID);
    const memberQueue = await listRoleQueue(db, companyId, "engineer", MEMBER_ID);

    expect(outsiderQueue.map((entry) => entry.issueId)).toEqual([open]);
    expect(memberQueue.map((entry) => entry.issueId).sort()).toEqual([scoped, open].sort());
  });

  it("a manual assignment is never gated: the assigned task stays in the assignee's queue", async () => {
    const companyId = await seedCompany();
    await seedAgent(companyId, OUTSIDER_ID, "outsider-eng");
    const projectId = await seedProject(companyId);
    const issueId = await seedTask(companyId, "TASK-1", projectId);
    await db.update(issues).set({ assigneeAgentId: OUTSIDER_ID }).where(eqId(issueId));

    const queue = await listRoleQueue(db, companyId, "engineer", OUTSIDER_ID);

    expect(queue.map((entry) => entry.issueId)).toEqual([issueId]);
  });

  it("the roster map lists lead projects and joined memberships of agents only", async () => {
    const companyId = await seedCompany();
    await seedAgent(companyId, OUTSIDER_ID, "outsider-eng");
    await seedAgent(companyId, MEMBER_ID, "member-eng");
    const ledProject = await seedProject(companyId, OUTSIDER_ID);
    const joinedProject = await seedProject(companyId);
    await join(companyId, joinedProject, MEMBER_ID);
    await join(companyId, joinedProject, "human-user-1");
    await join(companyId, ledProject, MEMBER_ID, "left");

    const byAgent = await listAgentProjectIds(db, companyId);

    expect(byAgent.get(OUTSIDER_ID)).toEqual([ledProject]);
    expect(byAgent.get(MEMBER_ID)).toEqual([joinedProject]);
    expect(byAgent.has("human-user-1")).toBe(false);
  });

  it("an agent nested in the project, with no membership row, is a member everywhere", async () => {
    const companyId = await seedCompany();
    await seedAgent(companyId, OUTSIDER_ID, "outsider-eng");
    await seedAgent(companyId, MEMBER_ID, "nested-eng");
    const projectId = await seedProject(companyId);
    await nest(companyId, projectId, MEMBER_ID);
    const scoped = await seedTask(companyId, "TASK-SCOPED", projectId);

    // role queue (SQL gate)
    const nestedQueue = await listRoleQueue(db, companyId, "engineer", MEMBER_ID);
    const outsiderQueue = await listRoleQueue(db, companyId, "engineer", OUTSIDER_ID);
    expect(nestedQueue.map((entry) => entry.issueId)).toEqual([scoped]);
    expect(outsiderQueue).toEqual([]);

    // roster projectIds
    const byAgent = await listAgentProjectIds(db, companyId);
    expect(byAgent.get(MEMBER_ID)).toEqual([projectId]);
    expect(byAgent.has(OUTSIDER_ID)).toBe(false);

    // matcher: the nested agent wins over the outsider that sorts first
    const pair = await matchIssue(matcher(), scoped);
    expect(pair?.agentId).toBe(MEMBER_ID);
  });
});
