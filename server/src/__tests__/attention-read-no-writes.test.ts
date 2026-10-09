// attention feed read path is write-free (latency fix part C): the GET projects
// the stored decision-retention state and parks the snapshot for a debounced
// per-company background pass, which is the only writer. Live embedded
// postgres, same recipe as attention-feed-swr-cache.test.ts.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  companies,
  createDb,
  decisionArchiveNotificationOutbox,
  decisionQueueItems,
  decisionQueues,
  decisionRetention,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: vi.fn(function child() {
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

import { attentionService, invalidateAttentionFeedCache } from "../services/attention.js";
import {
  DEFAULT_DECISION_SHELF_DAYS,
  decisionRetentionService,
} from "../services/decision-retention.js";
import {
  DECISION_RETENTION_SYNC_MIN_INTERVAL_MS,
  createDecisionRetentionSyncScheduler,
} from "../services/decision-retention-sync.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const TEST_SERVICE_OPTS = { feedCacheTtlMs: 0, failedRunHorizonDays: 3650 };

describeEmbeddedPostgres("attention feed read path: no decision-retention writes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  // every insert/update issued through this client, recorded by target table
  let insertedTables: unknown[] = [];
  let updatedTables: unknown[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-attention-read-no-writes-");
    db = createDb(tempDb.connectionString);
    const originalInsert = db.insert.bind(db) as (...args: unknown[]) => unknown;
    (db as unknown as Record<string, unknown>).insert = (...args: unknown[]) => {
      insertedTables.push(args[0]);
      return originalInsert(...args);
    };
    const originalUpdate = db.update.bind(db) as (...args: unknown[]) => unknown;
    (db as unknown as Record<string, unknown>).update = (...args: unknown[]) => {
      updatedTables.push(args[0]);
      return originalUpdate(...args);
    };
  }, 30_000);

  afterEach(async () => {
    insertedTables = [];
    updatedTables = [];
    await db.delete(decisionArchiveNotificationOutbox);
    await db.delete(decisionQueueItems);
    await db.delete(decisionQueues);
    await db.delete(decisionRetention);
    await db.delete(approvals);
    await db.delete(activityLog);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function countWritesTo(table: unknown) {
    return insertedTables.filter((entry) => entry === table).length
      + updatedTables.filter((entry) => entry === table).length;
  }

  function resetWriteLog() {
    insertedTables = [];
    updatedTables = [];
  }

  async function seedCompanyWithPendingApproval(prefix = "RNC") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const approvalId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `${prefix} Co`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Worker",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "hire_agent",
      status: "pending",
      payload: { title: "Hire Writer" },
      createdAt: new Date("2026-10-09T04:00:00.000Z"),
      updatedAt: new Date("2026-10-09T04:00:00.000Z"),
    });
    return { companyId, agentId, approvalId };
  }

  it("writes nothing to decision_retention on GET and lets the background pass store the snapshot", async () => {
    const { companyId, approvalId } = await seedCompanyWithPendingApproval("RNW");
    const scheduler = createDecisionRetentionSyncScheduler({ db });
    const list = () => {
      invalidateAttentionFeedCache(db, companyId);
      return attentionService(db, { ...TEST_SERVICE_OPTS, decisionRetentionSync: scheduler })
        .list(companyId, { userId: "board-user" });
    };

    resetWriteLog();
    const feed = await list();
    const item = feed.items.find((entry) => entry.dedupKey === `approval:${approvalId}`);
    expect(item).toBeDefined();
    // composition for a source the background pass has not stored yet
    expect(item?.keep).toBe(false);
    expect(item?.archivedAt).toBeNull();
    expect(item?.retentionVersion).toBe(0);
    expect(item?.retentionDays).toBe(DEFAULT_DECISION_SHELF_DAYS);
    // the point of the change: the read path is not a writer
    expect(countWritesTo(decisionRetention)).toBe(0);
    expect(scheduler.pendingCompanies()).toBe(1);

    // the parked snapshot is written by the scheduler, not by the request
    await scheduler.drain();
    const stored = await decisionRetentionService(db).getState(companyId, "approval", approvalId);
    expect(stored).not.toBeNull();

    resetWriteLog();
    const afterFeed = await list();
    const afterItem = afterFeed.items.find((entry) => entry.dedupKey === `approval:${approvalId}`);
    expect(afterItem?.retentionVersion).toBe(stored?.version);
    expect(afterItem?.retentionVersion).toBeGreaterThan(0);
    expect(afterItem?.keep).toBe(false);
    expect(afterItem?.archivedAt).toBeNull();
    expect(countWritesTo(decisionRetention)).toBe(0);
    scheduler.stop();
  });

  it("debounces the pass per company so a polling feed keeps writing at most once per interval", async () => {
    const { companyId } = await seedCompanyWithPendingApproval("RND");
    let clock = 1_000_000;
    const passes: number[] = [];
    const scheduler = createDecisionRetentionSyncScheduler({
      db,
      minIntervalMs: DECISION_RETENTION_SYNC_MIN_INTERVAL_MS,
      now: () => clock,
      syncItems: async (id, items) => {
        passes.push(items.length);
        await decisionRetentionService(db).syncItems(id, items);
      },
    });
    const list = () => {
      invalidateAttentionFeedCache(db, companyId);
      return attentionService(db, { ...TEST_SERVICE_OPTS, decisionRetentionSync: scheduler })
        .list(companyId, { userId: "board-user" });
    };

    await list();
    await scheduler.drain();
    expect(passes).toHaveLength(1);

    await list();
    await scheduler.drain();
    expect(passes).toHaveLength(1); // still inside the debounce window
    expect(scheduler.pendingCompanies()).toBe(1);

    clock += DECISION_RETENTION_SYNC_MIN_INTERVAL_MS;
    await scheduler.drain();
    expect(passes).toHaveLength(2);
    expect(scheduler.pendingCompanies()).toBe(0);
    scheduler.stop();
  });

  it("renders stored keep/archivedAt/retentionDays without writing on the read path", async () => {
    const { companyId, approvalId } = await seedCompanyWithPendingApproval("RNR");
    const archivedAt = new Date("2026-10-09T03:00:00.000Z");
    await db.insert(decisionRetention).values({
      companyId,
      sourceKind: "approval",
      sourceId: approvalId,
      keep: true,
      archivedAt,
      sourceActivityAt: new Date("2026-10-09T04:00:00.000Z"),
      version: 3,
      updatedAt: new Date("2026-10-09T04:00:00.000Z"),
    });
    const scheduler = createDecisionRetentionSyncScheduler({ db });

    resetWriteLog();
    invalidateAttentionFeedCache(db, companyId);
    const feed = await attentionService(db, { ...TEST_SERVICE_OPTS, decisionRetentionSync: scheduler })
      .list(companyId, { userId: "board-user" });
    const item = feed.items.find((entry) => entry.dedupKey === `approval:${approvalId}`);
    expect(item?.keep).toBe(true);
    expect(item?.archivedAt).toBe(archivedAt.toISOString());
    expect(item?.retentionVersion).toBe(3);
    expect(item?.retentionDays).toBe(DEFAULT_DECISION_SHELF_DAYS);
    expect(countWritesTo(decisionRetention)).toBe(0);
    scheduler.stop();
  });
});