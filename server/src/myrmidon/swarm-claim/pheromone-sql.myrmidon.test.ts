// myrmidon(1.6.5 F-27 PHEROMONE, review #1047): the SQL twins on a real
// Postgres. The pure helpers (`effectivePheromone`, `orderSwarmQueueCandidates`)
// are covered without a database elsewhere; what the review found missing is
// that the SQL halves — the evaporation count, the queue ORDER BY, the caste
// routing — agree with them on rows the production database actually holds:
//
//   1. the failed-run penalty survives the run's own release stamp
//      (`updated_at = finished_at`) and lifts only on a real change;
//   2. the candidate cut (LIMIT) is ordered by the effective strength, so a
//      fresh strong task behind 200 older weak ones is still a candidate;
//   3. the routing twin sends a task to exactly the castes the JS twin does;
//   4. a project cannot be created with a default caste the company lacks.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentCastes,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueLabels,
  issues,
  labels,
  projects,
} from "@paperclipai/db";
import {
  DEFAULT_PHEROMONE_DYNAMICS,
  orderSwarmQueueCandidates,
} from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";

vi.mock("../../middleware/logger.js", () => ({
  logger: {
    child: vi.fn(function child(this: unknown) {
      return this;
    }),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
  httpLogger: vi.fn(),
}));

import { roleQueueRows } from "./queue.js";
import { rolesOfQueueRow } from "./idle-queue.js";
import { projectService } from "../../services/projects.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describeEmbeddedPostgres("F-27 pheromone: the SQL twins agree with the shared helpers", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-pheromone-sql-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issueLabels);
    await db.delete(labels);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agentCastes);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-a",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedIssue(
    companyId: string,
    overrides: Partial<typeof issues.$inferInsert> = {},
  ): Promise<string> {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: `task ${id.slice(0, 6)}`,
      status: "todo",
      priority: "medium",
      ...overrides,
    });
    return id;
  }

  async function seedFailedRun(
    companyId: string,
    agentId: string,
    issueId: string,
    finishedAt: Date,
    status = "failed",
  ) {
    const [run] = await db
      .insert(heartbeatRuns)
      .values({ companyId, agentId, status, finishedAt, nativeIssueId: issueId })
      .returning();
    return run!.id;
  }

  async function failedRunsOf(companyId: string, issueId: string): Promise<number> {
    const rows = await roleQueueRows(db, companyId, "engineer");
    const row = rows.find((candidate) => candidate.issueId === issueId);
    expect(row, "the task is in the engineer queue").toBeDefined();
    return row!.failedRunsSinceLastChange ?? 0;
  }

  it("the failed-run penalty is not wiped by the run's own release stamp, and lifts only on a real change", async () => {
    const { companyId, agentId } = await seedCompany();
    const finishedAt = new Date(Date.now() - 2 * HOUR);
    const issueId = await seedIssue(companyId, { pheromoneStrength: 50 });
    const runId = await seedFailedRun(companyId, agentId, issueId, finishedAt);

    // What `releaseIssueExecutionAndPromote` does on the run's end: stamp the
    // task with the run's finish time (the 0355 trigger lifts last_activity_at
    // with it). Before the fix this made the count 0 forever.
    await db.update(issues).set({ updatedAt: finishedAt }).where(eq(issues.id, issueId));
    expect(await failedRunsOf(companyId, issueId)).toBe(1);

    // The system actor (sweeps, claim bookkeeping) is not a change to the task.
    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "swarm-claim",
      action: "issue.swarm_claim.released",
      entityType: "issue",
      entityId: issueId,
      createdAt: new Date(finishedAt.getTime() + 60_000),
    });
    // Per-user inbox bookkeeping is not a change either.
    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "board-user",
      action: "issue.read_marked",
      entityType: "issue",
      entityId: issueId,
      createdAt: new Date(finishedAt.getTime() + 61_000),
    });
    // The failed run's own comment is part of the failure, not a change after it.
    await db.insert(issueComments).values({
      companyId,
      issueId,
      body: "blocked: no access",
      createdByRunId: runId,
      createdAt: new Date(finishedAt.getTime() + 62_000),
    });
    expect(await failedRunsOf(companyId, issueId)).toBe(1);

    // A person comments after the run: the penalty is lifted.
    await db.insert(issueComments).values({
      companyId,
      issueId,
      body: "access granted, retry",
      authorUserId: "board-user",
      createdAt: new Date(finishedAt.getTime() + 10 * 60_000),
    });
    expect(await failedRunsOf(companyId, issueId)).toBe(0);
  });

  it("a person's edit (audit row outside the run) lifts the penalty; a later failed run counts again", async () => {
    const { companyId, agentId } = await seedCompany();
    const issueId = await seedIssue(companyId);
    const firstEnd = new Date(Date.now() - 3 * HOUR);
    await seedFailedRun(companyId, agentId, issueId, firstEnd);
    await seedFailedRun(companyId, agentId, issueId, new Date(firstEnd.getTime() + 30 * 60_000), "needs_followup");
    expect(await failedRunsOf(companyId, issueId)).toBe(2);

    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "board-user",
      action: "issue.updated",
      entityType: "issue",
      entityId: issueId,
      createdAt: new Date(firstEnd.getTime() + 15 * 60_000),
    });
    // The edit came after the first run and before the second: only the second counts.
    expect(await failedRunsOf(companyId, issueId)).toBe(1);

    // A cancelled run is an operator action, not an evaporating failure.
    await seedFailedRun(companyId, agentId, issueId, new Date(), "cancelled");
    expect(await failedRunsOf(companyId, issueId)).toBe(1);
  });

  it("the candidate cut is ordered by effective strength: a fresh strong task behind 200 older weak ones is first", async () => {
    const { companyId } = await seedCompany();
    const now = new Date();
    const weak = Array.from({ length: 205 }, (_, index) => ({
      id: randomUUID(),
      companyId,
      title: `weak ${index}`,
      status: "todo",
      priority: "medium",
      pheromoneStrength: 0,
      createdAt: new Date(now.getTime() - 40 * DAY + index * 1000),
    }));
    await db.insert(issues).values(weak);
    const strongId = await seedIssue(companyId, {
      title: "fresh and strong",
      pheromoneStrength: 500,
      createdAt: new Date(now.getTime() - 1000),
    });

    const rows = await roleQueueRows(db, companyId, "engineer", undefined, { now });
    expect(rows).toHaveLength(200);
    expect(rows[0]!.issueId).toBe(strongId);
  });

  it("the SQL order equals orderSwarmQueueCandidates (aging, penalty, P0 on and off)", async () => {
    const { companyId, agentId } = await seedCompany();
    const now = new Date();
    const mk = (title: string, strength: number, ageMs: number, priority = "medium") =>
      seedIssue(companyId, {
        title,
        priority,
        pheromoneStrength: strength,
        createdAt: new Date(now.getTime() - ageMs),
      });
    const a = await mk("a fresh 10", 10, 60_000);
    const b = await mk("b fresh 12 twice failed", 12, 2 * 60_000);
    const c = await mk("c 3 days 5", 5, 3 * DAY);
    const d = await mk("d 10 days 8 (aging capped)", 8, 10 * DAY);
    const e = await mk("e low but huge", 1000, 3 * 60_000, "low");
    const f = await mk("f critical zero", 0, 4 * 60_000, "critical");
    await seedFailedRun(companyId, agentId, b, new Date(now.getTime() - 30 * 60_000));
    await seedFailedRun(companyId, agentId, b, new Date(now.getTime() - 20 * 60_000));

    for (const p0Preemption of [true, false]) {
      const rows = await roleQueueRows(db, companyId, "engineer", undefined, {
        now,
        p0Preemption,
        dynamics: DEFAULT_PHEROMONE_DYNAMICS,
      });
      const sqlOrder = rows.map((row) => row.issueId);
      const jsOrder = orderSwarmQueueCandidates(
        rows.map((row) => ({
          issueId: row.issueId,
          priority: row.priority,
          pheromoneStrength: row.pheromoneStrength,
          failedRunsSinceLastChange: row.failedRunsSinceLastChange,
          queuedAt: row.queuedAt,
        })),
        { p0Preemption, dynamics: DEFAULT_PHEROMONE_DYNAMICS, now },
      ).map((candidate) => candidate.issueId);
      expect(sqlOrder).toEqual(jsOrder);
      expect(new Set(sqlOrder)).toEqual(new Set([a, b, c, d, e, f]));
      // The two ends of the contract, not only agreement with the helper.
      expect(sqlOrder[0]).toBe(p0Preemption ? f : e);
    }
  });

  it("the routing twin sends each task to exactly the castes the JS twin names", async () => {
    const { companyId } = await seedCompany();
    const [qaProject] = await db
      .insert(projects)
      .values({ companyId, name: "qa nest", defaultCasteKey: "qa" })
      .returning();
    const [engProject] = await db
      .insert(projects)
      .values({ companyId, name: "eng nest", defaultCasteKey: "engineer" })
      .returning();

    const labelIds = new Map<string, string>();
    for (const name of ["role:qa", "Role: Docs"]) {
      const [row] = await db.insert(labels).values({ companyId, name, color: "#888888" }).returning();
      labelIds.set(name, row!.id);
    }
    const fixtures = [
      { key: "t1 bare", casteKey: null, projectId: null, label: null, projectDefault: null },
      { key: "t2 caste beats label", casteKey: "reviewer", projectId: null, label: "role:qa", projectDefault: null },
      { key: "t3 project default", casteKey: null, projectId: qaProject!.id, label: null, projectDefault: "qa" },
      { key: "t4 legacy label", casteKey: null, projectId: null, label: "role:qa", projectDefault: null },
      { key: "t5 legacy spaced label", casteKey: null, projectId: null, label: "Role: Docs", projectDefault: null },
      { key: "t6 project default engineer", casteKey: null, projectId: engProject!.id, label: null, projectDefault: "engineer" },
      { key: "t7 own caste beats label", casteKey: "engineer", projectId: null, label: "role:qa", projectDefault: null },
    ] as const;
    const ids = new Map<string, string>();
    for (const fixture of fixtures) {
      const id = await seedIssue(companyId, {
        title: fixture.key,
        casteKey: fixture.casteKey,
        projectId: fixture.projectId,
      });
      ids.set(fixture.key, id);
      if (fixture.label) {
        await db.insert(issueLabels).values({ issueId: id, labelId: labelIds.get(fixture.label)!, companyId });
      }
    }

    const expected: Record<string, string[]> = {
      engineer: ["t1 bare", "t6 project default engineer", "t7 own caste beats label"],
      reviewer: ["t2 caste beats label"],
      qa: ["t3 project default", "t4 legacy label"],
      docs: ["t5 legacy spaced label"],
    };
    for (const [role, keys] of Object.entries(expected)) {
      const rows = await roleQueueRows(db, companyId, role);
      expect(new Set(rows.map((row) => row.issueId)), `SQL queue of ${role}`).toEqual(
        new Set(keys.map((key) => ids.get(key)!)),
      );
    }
    // The JS twin (the idle pass) names the same single caste for every fixture.
    for (const fixture of fixtures) {
      const castes = rolesOfQueueRow({
        candidate: {} as never,
        assigneeAgentId: null,
        assigneeRole: null,
        labels: fixture.label ? [fixture.label.toLowerCase()] : [],
        casteKey: fixture.casteKey,
        projectDefaultCasteKey: fixture.projectDefault,
      });
      const sqlCastes = Object.entries(expected)
        .filter(([, keys]) => keys.includes(fixture.key))
        .map(([role]) => role);
      expect(castes, fixture.key).toEqual(sqlCastes);
    }
  });

  it("a project cannot be created with a default caste the company does not have", async () => {
    const { companyId } = await seedCompany();
    const service = projectService(db);

    await expect(
      service.create(companyId, { name: "ghost nest", defaultCasteKey: "ghost" }),
    ).rejects.toMatchObject({ status: 422, details: { code: "project_caste_unknown" } });
    expect(await db.select({ id: projects.id }).from(projects)).toHaveLength(0);

    await db.insert(agentCastes).values({ companyId, key: "reviewer", nameEn: "Reviewer" });
    const created = await service.create(companyId, { name: "real nest", defaultCasteKey: "reviewer" });
    expect(created.defaultCasteKey).toBe("reviewer");
  });
});
