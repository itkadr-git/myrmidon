// OPE-9181: exercise the lease-expiry/manual-assignment race at N=200 on PostgreSQL.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { agents, companies, createDb, issueClaims, issues, type Db } from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { clearExpiredAssignee, releaseClaim } from "./store.js";

const externalTestDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported || externalTestDatabaseUrl ? describe : describe.skip;
const taskCount = 200;
const companyId = randomUUID();
const ownerId = randomUUID();
const explicitlyAssignedId = randomUUID();
const now = new Date();
let db: Db;
let tempDb: EmbeddedPostgresTestDatabase | undefined;
let taskIds: string[] = [];

async function seedFixtures() {
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
  await db.insert(issues).values(taskIds.map((id, index) => ({
    id,
    companyId,
    title: `lease expiry race ${index + 1}`,
    status: "todo",
    priority: "medium",
    assigneeAgentId: ownerId,
    updatedAt: new Date(now.getTime() - 10_000),
  })));
  await db.insert(issueClaims).values(taskIds.map((issueId) => ({
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
  })));
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
    await seedFixtures();
  }, 60_000);

  afterAll(async () => {
    if (db) {
      await db.delete(issueClaims).where(inArray(issueClaims.issueId, taskIds));
      await db.delete(issues).where(inArray(issues.id, taskIds));
      await db.delete(agents).where(eq(agents.companyId, companyId));
      await db.delete(companies).where(eq(companies.id, companyId));
    }
    await tempDb?.cleanup();
  }, 60_000);

  it("preserves every explicit reassignment and never leaves duplicate live leases", async () => {
    const startedAt = Date.now();
    const claims = await db
      .select({ issueId: issueClaims.issueId, id: issueClaims.id, agentId: issueClaims.agentId })
      .from(issueClaims)
      .where(and(inArray(issueClaims.issueId, taskIds), isNull(issueClaims.releasedAt)));
    expect(claims).toHaveLength(taskCount);

    const results = await Promise.all(claims.map(async (claim, index) => {
      const explicitAgentId = explicitlyAssignedId;
      await db.insert(issueClaims).values({
        id: randomUUID(),
        companyId,
        issueId: claim.issueId,
        agentId: claim.agentId,
        executionRunId: randomUUID(),
        claimOrigin: "matcher",
        claimedAt: new Date(now.getTime() - 120_000),
        leaseExpiresAt: new Date(now.getTime() - 60_000),
      });
      const explicitAt = new Date(now.getTime() + index + 1);
      const sweepExpiry = async () => Promise.all([
        releaseClaim(db, { claimId: claim.id, reason: "lease_expired", now }),
        clearExpiredAssignee(db, {
          companyId,
          issueId: claim.issueId,
          agentId: claim.agentId,
          claimId: claim.id,
          now,
        }),
      ]);

      await db.insert(issueClaims).values({
        id: randomUUID(),
        companyId,
        issueId: claim.issueId,
        agentId: explicitlyAssignedId,
        runId: randomUUID(),
        origin: "explicit",
        role: "engineer",
        claimedAt: explicitAt,
        heartbeatAt: explicitAt,
        expiresAt: new Date(explicitAt.getTime() + 60_000),
      });

      const [clearResults] = await Promise.all([
        sweepExpiry(),
        db.update(issues)
          .set({ assigneeAgentId: explicitAgentId, updatedAt: explicitAt })
          .where(eq(issues.id, claim.issueId)),
      ]);
      return { claim, explicitAgentId, cleared: clearResults[1] };
    }));

    const finalRows = await db
      .select({ id: issues.id, assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(inArray(issues.id, taskIds));
    const assignmentsLost = results.filter(({ explicitAgentId, claim }) =>
      finalRows.find((row) => row.id === claim.issueId)?.assigneeAgentId !== explicitAgentId,
    ).length;
    const counts = await activeClaimCounts();
    const duplicateActiveLeases = counts.filter((count) => count > 1).length;

    expect(results.every(({ cleared }) => !cleared)).toBe(true);
    expect(assignmentsLost).toBe(0);
    expect(duplicateActiveLeases).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(60_000);
  }, 60_000);
});
