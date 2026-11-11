// myrmidon(1.7 PRIVATE-TASKS C2, OPE-12704): a private task must never appear
// in the role queue and must never be claimed by the swarm matcher, even when
// it sits unassigned in a queue status.
//
// The predicate is exercised on embedded Postgres so the assertions cover the
// executed query, not just the expression builder (a fake that never runs the
// SQL proves nothing).
//
// REVIEW (OPE-12704): tests must not share mutable DB state. `matchAgent`
// assigns the public task, so every test seeds its own fresh private+public
// pair and removes it afterwards; nothing leaks between tests.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
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
import { matchAgent, readSwarmQueueCounters, type SwarmMatcherDeps } from "./matcher.js";
import { assignIssueToAgentForIdleClaim } from "./store.js";

const NOW = new Date("2026-11-11T00:00:00.000Z");
const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

function stableUuid(namespace: number, index: number): string {
  return `${namespace.toString(16).padStart(8, "0")}-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

const companyId = stableUuid(0xA1, 0);
const engineerId = stableUuid(0xA2, 0);

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

interface TaskPair {
  privateIssueId: string;
  publicIssueId: string;
}

describeDatabase("swarm private-claim exclusion", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let pairSeq = 0;

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
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 60_000);

  /** Fresh unassigned private+public todo pair, unique per call. */
  async function seedTaskPair(): Promise<TaskPair> {
    pairSeq += 1;
    const privateIssueId = stableUuid(0xA3, pairSeq * 2);
    const publicIssueId = stableUuid(0xA3, pairSeq * 2 + 1);
    await db.insert(issues).values([
      {
        id: privateIssueId,
        companyId,
        title: "Private task",
        identifier: `PCT-${pairSeq * 2}`,
        status: "todo",
        priority: "medium",
        casteKey: "engineer",
        isPrivate: true,
      },
      {
        id: publicIssueId,
        companyId,
        title: "Public task",
        identifier: `PCT-${pairSeq * 2 + 1}`,
        status: "todo",
        priority: "medium",
        casteKey: "engineer",
        isPrivate: false,
      },
    ]);
    return { privateIssueId, publicIssueId };
  }

  /** Remove the pair and any leases/assignments a matcher pass created. */
  async function removeTaskPair(pair: TaskPair): Promise<void> {
    const ids = [pair.privateIssueId, pair.publicIssueId];
    await db.delete(issueClaims).where(inArray(issueClaims.issueId, ids));
    await db.delete(issues).where(inArray(issues.id, ids));
  }

  it("excludes the private task from listRoleQueue", async () => {
    const pair = await seedTaskPair();
    try {
      const rows = await listRoleQueue(db, companyId, "engineer", undefined, undefined, new Map());
      expect(rows).toHaveLength(1);
      expect(rows[0]!.issueId).toBe(pair.publicIssueId);
    } finally {
      await removeTaskPair(pair);
    }
  });

  // The first matchAgent pass pays the dynamic import of services/issues.js
  // inside the claim transaction (cold transform), same as the sibling
  // cross-project-load test, which allows 120s for its matcher passes.
  it("matchAgent never claims the private task but claims the public one", async () => {
    const pair = await seedTaskPair();
    try {
      const deps = makeDeps(db);
      const result = await matchAgent(deps, engineerId);
      expect(result).not.toBeNull();
      expect(result!.issueId).toBe(pair.publicIssueId);

      const claims = await db.select({
        issueId: issueClaims.issueId,
        agentId: issueClaims.agentId,
      }).from(issueClaims).where(eq(issueClaims.companyId, companyId));
      expect(claims).toHaveLength(1);
      expect(claims[0]!.issueId).toBe(pair.publicIssueId);
      expect(claims[0]!.agentId).toBe(engineerId);

      const privateRow = await db.select({
        assigneeAgentId: issues.assigneeAgentId,
      }).from(issues).where(eq(issues.id, pair.privateIssueId));
      expect(privateRow[0]!.assigneeAgentId).toBeNull();
    } finally {
      await removeTaskPair(pair);
    }
  }, 300_000);

  it("returns the private task to the queue once isPrivate is cleared", async () => {
    const pair = await seedTaskPair();
    try {
      await db.update(issues).set({ isPrivate: false }).where(eq(issues.id, pair.privateIssueId));
      const rows = await listRoleQueue(db, companyId, "engineer", undefined, undefined, new Map());
      expect(rows).toHaveLength(2);
      const ids = rows.map((row) => row.issueId);
      expect(ids).toContain(pair.privateIssueId);
      expect(ids).toContain(pair.publicIssueId);
    } finally {
      await removeTaskPair(pair);
    }
  });

  it("assignIssueToAgentForIdleClaim refuses a private task", async () => {
    const pair = await seedTaskPair();
    try {
      const ok = await assignIssueToAgentForIdleClaim(db, {
        companyId,
        issueId: pair.privateIssueId,
        agentId: engineerId,
        now: NOW,
      });
      expect(ok).toBe(false);
      const row = await db.select({
        assigneeAgentId: issues.assigneeAgentId,
      }).from(issues).where(eq(issues.id, pair.privateIssueId));
      expect(row[0]!.assigneeAgentId).toBeNull();
    } finally {
      await removeTaskPair(pair);
    }
  });

  it("the queue counter does not count private tasks", async () => {
    const pair = await seedTaskPair();
    try {
      const before = await readSwarmQueueCounters(db, { companyIds: [companyId], now: NOW });
      expect(before.queuedUnassigned).toBe(1); // only the public task

      await db.update(issues).set({ isPrivate: false }).where(eq(issues.id, pair.privateIssueId));
      const after = await readSwarmQueueCounters(db, { companyIds: [companyId], now: NOW });
      expect(after.queuedUnassigned).toBe(2); // the cleared task rejoins the count
    } finally {
      await removeTaskPair(pair);
    }
  });
});
