// myrmidon(1.7 PRIVATE-TASKS C2, OPE-12704): a private task must never appear
// in the role queue and must never be claimed by the swarm matcher, even when
// it sits unassigned in a queue status.
//
// The predicate is exercised on embedded Postgres so the assertions cover the
// executed query, not just the expression builder (a fake that never runs the
// SQL proves nothing).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agentCastes,
  agents,
  companies,
  createDb,
  issueClaims,
  issues,
} from "@myrmidon/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { listRoleQueue } from "./queue.js";
import { matchAgent, type SwarmMatcherDeps } from "./matcher.js";
import { assignIssueToAgentForIdleClaim } from "./store.js";

const NOW = new Date("2026-11-11T00:00:00.000Z");
const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

function stableUuid(namespace: number, index: number): string {
  return `${namespace.toString(16).padStart(8, "0")}-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

const companyId = stableUuid(0xA1, 0);
const engineerId = stableUuid(0xA2, 0);
const privateIssueId = stableUuid(0xA3, 0);
const publicIssueId = stableUuid(0xA3, 1);

const claimSettings = {
  enabled: true,
  maxActiveTasks: 5,
  leaseTtlSec: 300,
  capacityPolicy: { enabled: false },
};

function makeDeps(db: ReturnType<typeof createDb>): SwarmMatcherDeps {
  return {
    db,
    heartbeat: { wakeup: async () => ({ queued: true }) },
    settings: claimSettings,
    hostGateOpen: true,
    now: NOW,
    casteDirectory: async () => [
      { key: "engineer", swarmEligible: true, maxActiveTasks: 5 },
    ],
    isAgentAvailable: async () => true,
    isIssueCoolingDown: async () => false,
    isTaskBudgetBlocked: async () => false,
  } as unknown as SwarmMatcherDeps;
}

describeDatabase("swarm private-claim exclusion", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-swarm-private-claim-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values({
      id: companyId,
      name: "Private claim test",
      issuePrefix: `PC${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agentCastes).values([
      { companyId, key: "engineer", nameEn: "Engineer", swarmEligible: true, isDefault: true },
    ]);
    await db.insert(agents).values({
      id: engineerId,
      companyId,
      name: "engineer-0",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      metadata: {},
    });
    await db.insert(issues).values([
      {
        id: privateIssueId,
        companyId,
        title: "Private task",
        identifier: "PCT-1",
        status: "todo",
        priority: "medium",
        casteKey: "engineer",
        isPrivate: true,
      },
      {
        id: publicIssueId,
        companyId,
        title: "Public task",
        identifier: "PCT-2",
        status: "todo",
        priority: "medium",
        casteKey: "engineer",
        isPrivate: false,
      },
    ]);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 60_000);

  it("excludes the private task from listRoleQueue", async () => {
    const rows = await listRoleQueue(db, companyId, "engineer", undefined, undefined, new Map());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.issueId).toBe(publicIssueId);
  });

  it("matchAgent never claims the private task but claims the public one", async () => {
    const deps = makeDeps(db);
    const result = await matchAgent(deps, engineerId);
    expect(result).not.toBeNull();
    expect(result!.issueId).toBe(publicIssueId);

    const claims = await db.select({
      issueId: issueClaims.issueId,
      agentId: issueClaims.agentId,
    }).from(issueClaims).where(eq(issueClaims.companyId, companyId));
    expect(claims).toHaveLength(1);
    expect(claims[0]!.issueId).toBe(publicIssueId);
    expect(claims[0]!.agentId).toBe(engineerId);

    const privateRow = await db.select({
      assigneeAgentId: issues.assigneeAgentId,
    }).from(issues).where(eq(issues.id, privateIssueId));
    expect(privateRow[0]!.assigneeAgentId).toBeNull();
  });

  it("returns the private task to the queue once isPrivate is cleared", async () => {
    await db.update(issues).set({ isPrivate: false }).where(eq(issues.id, privateIssueId));
    const rows = await listRoleQueue(db, companyId, "engineer", undefined, undefined, new Map());
    expect(rows).toHaveLength(2);
    const ids = rows.map((row) => row.issueId);
    expect(ids).toContain(privateIssueId);
    expect(ids).toContain(publicIssueId);
    // Restore the flag so later tests are not affected.
    await db.update(issues).set({ isPrivate: true }).where(eq(issues.id, privateIssueId));
  });

  it("assignIssueToAgentForIdleClaim refuses a private task", async () => {
    const ok = await assignIssueToAgentForIdleClaim(db, {
      companyId,
      issueId: privateIssueId,
      agentId: engineerId,
      now: NOW,
    });
    expect(ok).toBe(false);
    const row = await db.select({
      assigneeAgentId: issues.assigneeAgentId,
    }).from(issues).where(eq(issues.id, privateIssueId));
    expect(row[0]!.assigneeAgentId).toBeNull();
  });
});
