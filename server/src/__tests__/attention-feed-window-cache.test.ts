// attention-latency fix (part A3): horizon + cache behaviour for the feed.
// Live embedded postgres (same recipe as fallback-attention.myrmidon.test.ts).

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  instanceSettings,
  issues,
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

import {
  attentionService,
  invalidateAttentionFeedCache,
} from "../services/attention.js";
import { listAttentionExhaustedRuns } from "../services/attention-exhausted-runs.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("attention failed-run horizon and feed cache", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  let selectCount = 0;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-attention-window-cache-");
    db = createDb(tempDb.connectionString);
    // count every drizzle select issued through this client —
    // a cache hit must not start any feed query at all.
    const original = db.select.bind(db) as (...args: unknown[]) => unknown;
    (db as unknown as Record<string, unknown>).select = (...args: unknown[]) => {
      selectCount += 1;
      return original(...args);
    };
  }, 30_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(instanceSettings);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(prefix = "AWC") {
    const companyId = randomUUID();
    const workerId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `${prefix} Co`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: workerId,
      companyId,
      name: "Worker",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, workerId };
  }

  async function seedFailedRun(companyId: string, workerId: string, at: Date) {
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `AWC-${runId.slice(0, 6)}`,
      title: "Failed task",
      status: "in_progress",
      assigneeAgentId: workerId,
      updatedAt: at,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: workerId,
      invocationSource: "automation",
      status: "failed",
      error: "adapter failed",
      contextSnapshot: { issueId },
      createdAt: at,
      updatedAt: at,
      finishedAt: at,
    });
    await db.insert(heartbeatRunEvents).values({
      companyId,
      runId,
      agentId: workerId,
      seq: 1,
      eventType: "lifecycle",
      message: "Bounded retry exhausted after 4 scheduled attempts; no further automatic retry will be queued",
      createdAt: new Date(at.getTime() + 1_000),
    });
    return { issueId, runId };
  }

  const DAY = 24 * 60 * 60 * 1000;

  async function seedTwoFailedRuns(daysAgoOld: number, daysAgoFresh: number) {
    const { companyId, workerId } = await seedCompany();
    const oldAt = new Date(Date.now() - daysAgoOld * DAY);
    const freshAt = new Date(Date.now() - daysAgoFresh * DAY);
    const ids: Record<string, string> = {};
    for (const [tag, at] of [["old", oldAt], ["fresh", freshAt]] as const) {
      const issueId = randomUUID();
      const runId = randomUUID();
      ids[tag] = runId;
      await db.insert(issues).values({
        id: issueId,
        companyId,
        identifier: `AWC-${tag}`,
        title: `Failed task ${tag}`,
        status: "in_progress",
        assigneeAgentId: workerId,
        updatedAt: at,
      });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId: workerId,
        invocationSource: "automation",
        status: "failed",
        error: "adapter failed",
        contextSnapshot: { issueId },
        createdAt: at,
        updatedAt: at,
        finishedAt: at,
      });
      await db.insert(heartbeatRunEvents).values({
        companyId,
        runId,
        agentId: workerId,
        seq: 1,
        eventType: "lifecycle",
        message: "Bounded retry exhausted after 4 scheduled attempts; no further automatic retry will be queued",
        createdAt: at,
      });
    }
    // The inbox leg is keyed by issue.updatedAt (visible for 90d); keep the old
    // issue visible so that only the run-createdAt horizon drops its card.
    await db
      .update(issues)
      .set({ updatedAt: new Date() })
      .where(eq(issues.identifier, "AWC-old"));
    return { companyId, workerId, ...ids };
  }

  it("reads the horizon from instance_settings.general (365d keeps a 30d-old failure visible)", async () => {
    const seeded = await seedTwoFailedRuns(30, 1);
    await db.insert(instanceSettings)
      .values({
        singletonKey: "default",
        general: { attentionFailedRunHorizonDays: 365 },
      })
      .onConflictDoUpdate({
        target: instanceSettings.singletonKey,
        set: { general: { attentionFailedRunHorizonDays: 365 } },
      });
    const feed = await attentionService(db, { settingsCacheTtlMs: 0 }).list(seeded.companyId);
    const failures = feed.items.filter((item) => item.sourceKind === "failed_run");
    expect(failures.map((item) => item.subject.id).sort()).toEqual([seeded.old, seeded.fresh].sort());
  });

  it("excludes failures older than the horizon and keeps fresh ones (explicit 7d)", async () => {
    const seeded = await seedTwoFailedRuns(30, 1);
    const feed = await attentionService(db, { failedRunHorizonDays: 7 }).list(seeded.companyId);
    const failures = feed.items.filter((item) => item.sourceKind === "failed_run");
    expect(failures.map((item) => item.subject.id).sort()).toEqual([seeded.fresh]);
  });

  it("bounds query 1 of the failed-run gather via the createdAtAfter floor", async () => {
    const seeded = await seedTwoFailedRuns(30, 1);
    const floor = new Date(Date.now() - 7 * DAY);
    const rows = await listAttentionExhaustedRuns(db, seeded.companyId, { createdAtAfter: floor });
    expect(rows.map((row) => row.id).sort()).toEqual([seeded.fresh]);
    // the unbounded call would return everything in the company — the floor is what bounds it
    const all = await listAttentionExhaustedRuns(db, seeded.companyId);
    expect(all.map((row) => row.id).sort()).toEqual([seeded.old, seeded.fresh].sort());
  });

  it("still suppresses a failed run with a newer successful run inside the horizon", async () => {
    const { companyId, workerId } = await seedCompany();
    const failedAt = new Date(Date.now() - 10 * DAY);
    const issueId = randomUUID();
    const failedRunId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "AWC-SUP",
      title: "Suppressed failure",
      status: "in_progress",
      assigneeAgentId: workerId,
      updatedAt: failedAt,
    });
    await db.insert(heartbeatRuns).values([
      {
        id: failedRunId,
        companyId,
        agentId: workerId,
        invocationSource: "automation",
        status: "failed",
        error: "adapter failed",
        contextSnapshot: { issueId },
        createdAt: failedAt,
        updatedAt: failedAt,
        finishedAt: failedAt,
      },
      {
        id: randomUUID(),
        companyId,
        agentId: workerId,
        invocationSource: "automation",
        status: "succeeded",
        contextSnapshot: { issueId },
        createdAt: new Date(Date.now() - 9 * DAY),
        updatedAt: new Date(Date.now() - 9 * DAY),
        finishedAt: new Date(Date.now() - 9 * DAY),
      },
    ]);
    await db.insert(heartbeatRunEvents).values({
      companyId,
      runId: failedRunId,
      agentId: workerId,
      seq: 1,
      eventType: "lifecycle",
      message: "Bounded retry exhausted after 4 scheduled attempts; no further automatic retry will be queued",
      createdAt: failedAt,
    });
    const feed = await attentionService(db, { failedRunHorizonDays: 14 }).list(companyId);
    expect(feed.items.filter((item) => item.sourceKind === "failed_run")).toEqual([]);
  });

  const databaseSelectCount = () => selectCount;

  it("serves the second list() inside the TTL from the cache and rebuilds after invalidation", async () => {
    const seeded = await seedTwoFailedRuns(30, 1);
    const svc = attentionService(db, { feedCacheTtlMs: 60_000, failedRunHorizonDays: 7 });

    const beforeFirst = databaseSelectCount();
    const first = await svc.list(seeded.companyId);
    const afterFirst = databaseSelectCount();
    const beforeSecond = afterFirst;
    const second = await svc.list(seeded.companyId);
    const afterSecond = databaseSelectCount();

    expect(first.items.filter((item) => item.sourceKind === "failed_run").map((i) => i.subject.id).sort()).toEqual([seeded.fresh]);
    expect(second).toEqual(first);
    expect(afterFirst - beforeFirst).toBeGreaterThanOrEqual(12);
    // cached snapshot: at most the memoised settings read may hit the db
    expect(afterSecond - beforeSecond).toBeLessThanOrEqual(2);

    invalidateAttentionFeedCache(db, seeded.companyId);
    const beforeThird = databaseSelectCount();
    const third = await svc.list(seeded.companyId);
    const afterThird = databaseSelectCount();
    // a rebuild stamps a fresh generatedAt; the feed content must be identical
    expect(third.items).toEqual(first.items);
    expect(afterThird - beforeThird).toBeGreaterThanOrEqual(12);
  });

});
