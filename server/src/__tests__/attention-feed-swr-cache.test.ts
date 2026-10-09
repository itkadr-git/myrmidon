// attention feed cache (latency fix part A): stale-while-revalidate behaviour.
// Live embedded postgres (same recipe as attention-feed-window-cache.test.ts).

import { randomUUID } from "node:crypto";
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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const TTL_MS = 60_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const EXHAUSTED_MESSAGE = "Bounded retry exhausted after 4 scheduled attempts; no further automatic retry will be queued";

describeEmbeddedPostgres("attention feed cache: stale-while-revalidate", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let selectCount = 0;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-attention-swr-");
    db = createDb(tempDb.connectionString);
    // count every drizzle select issued through this client: one feed build is
    // a known-size burst of queries, a cache hit is (nearly) none.
    const original = db.select.bind(db) as (...args: unknown[]) => unknown;
    (db as unknown as Record<string, unknown>).select = (...args: unknown[]) => {
      selectCount += 1;
      return original(...args);
    };
  }, 30_000);

  afterEach(async () => {
    vi.useRealTimers();
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

  async function seedCompany(prefix = "ASW") {
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
      identifier: `ASW-${runId.slice(0, 6)}`,
      title: `Failed task ${runId.slice(0, 6)}`,
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
      message: EXHAUSTED_MESSAGE,
      createdAt: new Date(at.getTime() + 1_000),
    });
    return { issueId, runId };
  }

  /** Failed-run cards keyed by their run id — the cheapest fingerprint of a snapshot. */
  const failedRunIds = (feed: Awaited<ReturnType<ReturnType<typeof attentionService>["list"]>>) =>
    feed.items.filter((item) => item.sourceKind === "failed_run").map((item) => item.subject.id).sort();

  // The settings read is memoised for 10 minutes so a burst of parallel calls
  // cannot add a settings query to the measured delta.
  const serviceWith = (feedCacheTtlMs: number) =>
    attentionService(db, { feedCacheTtlMs, failedRunHorizonDays: 7, settingsCacheTtlMs: 10 * MINUTE });

  /** Cost of one full rebuild for this company, measured after invalidating. */
  async function measureRebuild(service: ReturnType<typeof attentionService>, companyId: string) {
    invalidateAttentionFeedCache(db, companyId);
    const before = selectCount;
    await service.list(companyId);
    return selectCount - before;
  }

  const settle = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

  it("serves a snapshot inside the TTL without rebuilding", async () => {
    const { companyId, workerId } = await seedCompany();
    const seeded = await seedFailedRun(companyId, workerId, new Date(Date.now() - HOUR));
    const service = serviceWith(TTL_MS);

    const beforeFirst = selectCount;
    const first = await service.list(companyId);
    const firstCost = selectCount - beforeFirst;
    expect(failedRunIds(first)).toEqual([seeded.runId]);
    expect(firstCost).toBeGreaterThanOrEqual(12);

    const beforeSecond = selectCount;
    const second = await service.list(companyId);
    expect(selectCount - beforeSecond).toBe(0);
    expect(failedRunIds(second)).toEqual(failedRunIds(first));
    // one snapshot, one generatedAt: the cache hit must not restamp the feed
    // with the request time
    expect(second.generatedAt).toBe(first.generatedAt);
  });

  it("serves a snapshot older than the TTL at once and refreshes it with a single background rebuild", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const startedAt = Date.now();
    const { companyId, workerId } = await seedCompany();
    const first = await seedFailedRun(companyId, workerId, new Date(startedAt - HOUR));
    const service = serviceWith(TTL_MS);

    // snapshot with one failed-run card; the second entry appears afterwards and
    // must therefore be invisible to every stale reader
    expect(failedRunIds(await service.list(companyId))).toEqual([first.runId]);
    const latecomer = await seedFailedRun(companyId, workerId, new Date(startedAt - 30 * MINUTE));

    // inside the stale window (TTL < age <= 2 * TTL): readers get the snapshot
    // they already had, and the rebuild runs behind them
    vi.setSystemTime(startedAt + TTL_MS + 5_000);
    const beforeBurst = selectCount;
    const burst = await Promise.all(Array.from({ length: 5 }, () => service.list(companyId)));
    for (const feed of burst) expect(failedRunIds(feed)).toEqual([first.runId]);
    // all five stale readers report one snapshot, so one build time — a stale
    // feed must not claim the freshness of the poll that served it
    expect(new Set(burst.map((feed) => feed.generatedAt)).size).toBe(1);
    expect(Date.parse(burst[0]!.generatedAt)).toBeLessThanOrEqual(startedAt + TTL_MS + 5_000);

    // the background rebuild lands: the next read shows the new card and the
    // whole stale episode cost exactly one rebuild's worth of queries
    let refreshed = await service.list(companyId);
    for (let attempt = 0; attempt < 200 && failedRunIds(refreshed).length < 2; attempt += 1) {
      await settle();
      refreshed = await service.list(companyId);
    }
    const burstCost = selectCount - beforeBurst;
    expect(failedRunIds(refreshed)).toEqual([first.runId, latecomer.runId].sort());

    const rebuildCost = await measureRebuild(service, companyId);
    expect(burstCost).toBeGreaterThanOrEqual(rebuildCost - 2);
    expect(burstCost).toBeLessThanOrEqual(rebuildCost + 2);
  });

  it("waits for a fresh rebuild past 2 * TTL and shares it between parallel readers", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const startedAt = Date.now();
    const { companyId, workerId } = await seedCompany();
    const first = await seedFailedRun(companyId, workerId, new Date(startedAt - HOUR));
    const service = serviceWith(TTL_MS);

    expect(failedRunIds(await service.list(companyId))).toEqual([first.runId]);
    const latecomer = await seedFailedRun(companyId, workerId, new Date(startedAt - 30 * MINUTE));

    // past the stale window the reader must not be handed the old snapshot
    vi.setSystemTime(startedAt + 2 * TTL_MS + 5_000);
    const beforeBurst = selectCount;
    const burst = await Promise.all(Array.from({ length: 3 }, () => service.list(companyId)));
    const burstCost = selectCount - beforeBurst;
    for (const feed of burst) {
      expect(failedRunIds(feed)).toEqual([first.runId, latecomer.runId].sort());
    }

    const rebuildCost = await measureRebuild(service, companyId);
    expect(burstCost).toBeGreaterThanOrEqual(rebuildCost - 2);
    expect(burstCost).toBeLessThanOrEqual(rebuildCost + 2);
  });

  it("takes the 60 s default from instance_settings and skips the cache when it is 0", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const startedAt = Date.now();
    const { companyId, workerId } = await seedCompany();
    const seeded = await seedFailedRun(companyId, workerId, new Date(startedAt - HOUR));
    // no override and no instance_settings row: the TTL is the shipped default
    const service = attentionService(db, { settingsCacheTtlMs: 0 });

    expect(failedRunIds(await service.list(companyId))).toEqual([seeded.runId]);
    const latecomer = await seedFailedRun(companyId, workerId, new Date(startedAt - 30 * MINUTE));

    // 91 s > 60 s default: served stale without waiting (a 45 s default would
    // already have waited for a rebuild here)
    vi.setSystemTime(startedAt + 91_000);
    const beforeStale = selectCount;
    const stale = await service.list(companyId);
    expect(failedRunIds(stale)).toEqual([seeded.runId]);
    expect(selectCount - beforeStale).toBeLessThanOrEqual(2);

    // 121 s > 2 * 60 s: the read waits for a rebuild instead of serving stale
    vi.setSystemTime(startedAt + 121_000);
    const beforeHard = selectCount;
    const hard = await service.list(companyId);
    expect(failedRunIds(hard)).toEqual([seeded.runId, latecomer.runId].sort());
    expect(selectCount - beforeHard).toBeGreaterThanOrEqual(12);

    // attentionFeedCacheTtlSeconds = 0 disables the cache outright
    const uncached = serviceWith(0);
    const beforeFirst = selectCount;
    await uncached.list(companyId);
    const firstCost = selectCount - beforeFirst;
    const beforeSecond = selectCount;
    await uncached.list(companyId);
    expect(selectCount - beforeSecond).toBeGreaterThanOrEqual(firstCost - 2);
  });
});