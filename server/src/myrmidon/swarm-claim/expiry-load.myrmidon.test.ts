// OPE-9181: exercise the lease-expiry/manual-assignment race at N=200 on PostgreSQL.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { activityLog, agents, companies, createDb, issueClaims, issueRelations, issues, type Db } from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { issueService } from "../../services/issues.js";
import { openLoadByAgent } from "./matcher.js";
import { createSwarmClaimSweeper } from "./sweep.js";

const externalTestDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported || externalTestDatabaseUrl ? describe : describe.skip;
const taskCount = 200;
const companyId = randomUUID();
const ownerId = randomUUID();
const explicitlyAssignedId = randomUUID();
const blockerId = randomUUID();
const blockedTaskIds = Array.from({ length: 3 }, () => randomUUID());
const readyTaskId = randomUUID();
let db: Db;
let tempDb: EmbeddedPostgresTestDatabase | undefined;
let taskIds: string[] = [];

async function seedFixtures(now: Date) {
  taskIds = Array.from({ length: taskCount }, () => randomUUID());
  await db.insert(companies).values({
    id: companyId,
    name: `Expiry Load ${companyId.slice(0, 8)}`,
    issuePrefix: `EL${companyId.replaceAll("-", "").slice(0, 5).toUpperCase()}`,
  });
  await db.insert(agents).values([
    {
      id: ownerId,
      companyId,
      name: "expiry-load-owner",
      role: "engineer",
      status: "idle",
      adapterType: "paperclip_runner",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    },
    {
      id: explicitlyAssignedId,
      companyId,
      name: "expiry-load-explicit-assignee",
      role: "engineer",
      status: "idle",
      adapterType: "paperclip_runner",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    },
  ]);
  await db.insert(issues).values([
    ...taskIds.map((id, index) => ({
      id,
      companyId,
      title: `lease expiry race ${index + 1}`,
      status: "todo",
      priority: "medium",
      assigneeAgentId: ownerId,
      updatedAt: new Date(now.getTime() - 10_000),
    })),
    ...blockedTaskIds.map((id, index) => ({
      id,
      companyId,
      title: `blocked task ${index + 1}`,
      status: "todo",
      priority: "medium",
      assigneeAgentId: explicitlyAssignedId,
    })),
    {
      id: blockerId,
      companyId,
      title: "open blocker",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: null,
    },
    {
      id: readyTaskId,
      companyId,
      title: "ready work for agent with blocked todos",
      status: "todo",
      priority: "medium",
      assigneeAgentId: null,
    },
  ]);
  await db.insert(issueRelations).values(
    blockedTaskIds.map((blockedIssueId) => ({
      id: randomUUID(),
      companyId,
      issueId: blockerId,
      relatedIssueId: blockedIssueId,
      type: "blocks" as const,
    })),
  );
  await db.insert(activityLog).values({
    companyId,
    actorType: "system",
    actorId: "test",
    action: "test",
    entityType: "issue",
    entityId: randomUUID(),
  });
  await db.insert(issueClaims).values(
    taskIds.map((issueId) => ({
      id: randomUUID(),
      companyId,
      issueId,
      agentId: ownerId,
      runId: null,
      origin: "auto_match",
      role: "engineer",
      claimedAt: new Date(now.getTime() - 60_000),
      heartbeatAt: new Date(now.getTime() - 60_000),
      expiresAt: new Date(now.getTime() - 1_000),
    }))
  );
}

async function runExpirySweeps(now: Date) {
  const sweeper = createSwarmClaimSweeper({
    db,
    settings: {
      getGeneral: async () => ({
        swarmClaim: {
          enabled: true,
          leaseTtlSec: 900,
          maxActiveTasks: 3,
          sweepIntervalSec: 5,
          p0Preemption: true,
          pheromone: {},
        },
      }) as never,
    },
    env: {},
    intervalMs: 0,
    hostMemoryGate: () => ({ state: "open" } as never),
    hostCpuGate: () => ({ state: "open" } as never),
    enqueueWakeup: async () => ({ accepted: true }),
    castes: async () => [{ key: "engineer", swarmEligible: true, maxActiveTasks: 3 }],
  });
  let expiredReleased = 0;
  for (let pass = 0; pass < 8; pass++) {
    sweeper.resetForTest();
    const result = await sweeper.sweep(now);
    expiredReleased += result.expiredReleased;
    if (result.expiredReleased === 0) break;
  }
  return { expiredReleased };
}

async function activeClaimCounts(): Promise<number[]> {
  const rows = await db
    .select({ issueId: issueClaims.issueId })
    .from(issueClaims)
    .where(and(inArray(issueClaims.issueId, taskIds), isNull(issueClaims.releasedAt)));
  const counts = new Map(taskIds.map((id) => [id, 0]));
  for (const row of rows) counts.set(row.issueId, (counts.get(row.issueId) ?? 0) + 1);
  return [...counts.values()];
}

describeDatabase("swarm expiry race under load", () => {
  beforeAll(async () => {
    if (externalTestDatabaseUrl) {
      db = createDb(externalTestDatabaseUrl);
    } else {
      tempDb = (await startEmbeddedPostgresTestDatabase("paperclip-swarm-expiry-load-")) as EmbeddedPostgresTestDatabase;
      db = createDb(tempDb.connectionString);
    }
    await seedFixtures(new Date());
  }, 60_000);

  afterAll(async () => {
    if (db) {
      await db.delete(issueClaims).where(inArray(issueClaims.issueId, [...taskIds, ...blockedTaskIds, readyTaskId]));
      await db.delete(issueRelations).where(eq(issueRelations.companyId, companyId));
      await db.delete(activityLog).where(eq(activityLog.companyId, companyId));
      await db.delete(issues).where(eq(issues.companyId, companyId));
      await db.delete(agents).where(eq(agents.companyId, companyId));
      await db.delete(companies).where(eq(companies.id, companyId));
    }
    await tempDb?.cleanup();
  }, 60_000);

  it("does not count assigned todo tasks held by open blockers toward the matcher ceiling", async () => {
    const load = await openLoadByAgent(db, companyId);
    expect(load.get(explicitlyAssignedId) ?? 0).toBe(0);
    expect(load.get(ownerId) ?? 0).toBe(taskCount);
    const sweep = createSwarmClaimSweeper({
      db,
      settings: {
        getGeneral: async () => ({
          swarmClaim: {
            enabled: true,
            leaseTtlSec: 900,
            maxActiveTasks: 3,
            sweepIntervalSec: 5,
            p0Preemption: true,
            pheromone: {},
          },
        }) as never,
      },
      env: {},
      intervalMs: 0,
      hostMemoryGate: () => ({ state: "open" } as never),
      hostCpuGate: () => ({ state: "open" } as never),
      enqueueWakeup: async () => ({ accepted: true }),
      castes: async () => [{ key: "engineer", swarmEligible: true, maxActiveTasks: 3 }],
    });
    const result = await sweep.sweep(new Date());
    const ready = await db
      .select({ assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, readyTaskId));
    expect(ready[0]?.assigneeAgentId).toBe(explicitlyAssignedId);
    expect(result.idleClaimed).toBe(1);
  });

  it("preserves every explicit reassignment against an expiry sweep under load", async () => {
    const startedAt = Date.now();
    const now = new Date();
    const claims = await db
      .select({ issueId: issueClaims.issueId })
      .from(issueClaims)
      .where(and(inArray(issueClaims.issueId, taskIds), isNull(issueClaims.releasedAt)));
    expect(claims).toHaveLength(taskCount);

    const sweepPromise = runExpirySweeps(now);
    const assignments = taskIds.map((issueId, index) =>
      db.transaction(async (tx) =>
        issueService(tx as unknown as Db).update(issueId, {
          assigneeAgentId: explicitlyAssignedId,
          companyGuard: companyId,
          updatedAt: new Date(now.getTime() + index + 1),
        })
      )
    );
    const [assignmentResults] = await Promise.all([
      Promise.all(assignments),
      sweepPromise,
    ]);

    expect(assignmentResults.every((result) => result !== null)).toBe(true);

    // Complete sweep passes for any remaining claims to ensure full release
    await runExpirySweeps(now);

    const finalRows = await db
      .select({ id: issues.id, assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(inArray(issues.id, taskIds));
    const assignmentsLost = finalRows.filter(
      (row) => row.assigneeAgentId !== explicitlyAssignedId
    ).length;
    const counts = await activeClaimCounts();
    const duplicateActiveLeases = counts.filter((count) => count > 1).length;

    expect(assignmentsLost).toBe(0);
    expect(duplicateActiveLeases).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(60_000);
  }, 60_000);
});
