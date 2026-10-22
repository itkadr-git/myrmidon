// myrmidon(BOT-ROLLOUT): deferred bot rollout — a drift that found the bot
// busy is recorded, retried by the sweep's own watcher, applied once the bot
// frees up (without a new deploy), forced through the existing pause-and-apply
// path after the max wait (without ever interrupting a run), and retired by
// the backstop after the bounded grace.
//
// Guard property: on origin/main there IS no deferred record — the store is
// empty after any deferred pass, so the busy-bot test below (which asserts
// the record) fails there.
//
// The store tests run against an embedded Postgres (the same helper the other
// instance-settings-backed suites use); skipped where embedded postgres
// cannot start (e.g. as root), like the BOT-DISK suite.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, instanceSettings } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { BOT_CONTAINERS_ENV } from "./agent-config.js";
import { createBotKeyLock } from "./bot-key-lock.js";
import type { BotContainerDriver } from "./driver.js";
import {
  applyBotContainerNow,
  startBotContainerReconciliation,
  type BotContainerAgent,
  type BotContainerRuntimeDeps,
} from "./index.js";
import {
  BOT_ROLLOUT_DEFERRED_GENERAL_KEY,
  readBotRolloutDeferredDocument,
  upsertBotRolloutDeferredRecord,
  emptyBotRolloutDeferredDocument,
  type BotRolloutDeferredRecord,
} from "./deferred-store.js";
import {
  DEFAULT_BOT_ROLLOUT_DEFERRED_MAX_WAIT_SEC,
  BOT_ROLLOUT_DEFERRED_MAX_WAIT_ENV,
  readBotRolloutDeferredMaxWaitSec,
  runDeferredRolloutWatcher,
} from "./deferred-reconciler.js";
import type { BotMaintenancePort } from "./reconciler.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
// The DB-backed suite fails loudly when embedded Postgres cannot start: its
// tests are the guard (on origin/main there is no record at all), so a
// silent skip would hide a red guard.
const describeEmbeddedPostgres = describe;

const ENABLED = { [BOT_CONTAINERS_ENV]: "1" };

function agent(overrides: Partial<BotContainerAgent> = {}, containerOverrides: Record<string, unknown> = {}): BotContainerAgent {
  return {
    agentId: "agent-a",
    adapterType: "hermes_gateway",
    adapterConfig: {
      container: {
        enabled: true,
        image: "myrmidon-hermes:1.1.0",
        memoryMb: 512,
        cpus: 1,
        pidsLimit: 128,
        ...containerOverrides,
      },
    },
    ...overrides,
  };
}

function minimalDriver(overrides: Partial<BotContainerDriver> = {}): BotContainerDriver {
  return {
    status: async (botKey) => ({ botKey, state: "running", restartHash: "r", filesHash: "f" }),
    list: async () => [],
    templateDrift: async () => ({ drifted: false, fields: [] }),
    create: async () => {},
    recreate: async () => {},
    writeProfile: async () => {},
    start: async () => {},
    restart: async () => {},
    stop: async () => {},
    ...overrides,
  };
}

function deps(driver: BotContainerDriver, extra: Partial<BotContainerRuntimeDeps> = {}): BotContainerRuntimeDeps {
  return {
    driver,
    compile: async (_agentId, botKey) => ({ botKey, files: [], restartHash: "r", filesHash: "f" }),
    maintenance: {
      enter: async () => ({ state: "on" as const, runningRuns: 0, owned: true }),
      status: async () => ({ state: "on" as const, runningRuns: 0 }),
      exit: async () => {},
    },
    network: "myrmidon-bots",
    lock: createBotKeyLock(),
    ...extra,
  };
}

function makeRecord(overrides: Partial<BotRolloutDeferredRecord> = {}): BotRolloutDeferredRecord {
  return {
    botKey: "agent-a",
    agentId: "agent-a",
    targetImage: "myrmidon-hermes:1.2.0",
    firstDeferredAt: new Date().toISOString(),
    attempts: 0,
    lastReason: "busy",
    ...overrides,
  };
}

describeEmbeddedPostgres("myrmidon(BOT-ROLLOUT) deferred bot rollout", () => {
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    if (!embeddedPostgresSupport.supported) {
      throw new Error(
        `embedded Postgres is unavailable in this run (${embeddedPostgresSupport.reason ?? "unknown"}); ` +
          "the deferred-rollout tests assert the record exists, so silently skipping them would miss the guard",
      );
    }
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-bot-rollout-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // (a) A busy bot: the drifted change defers, the record is written, the
  // sweep is not blocked by it. Guard: on origin/main nothing is ever
  // recorded — readBotRolloutDeferredDocument returns an empty document and
  // this test is red there.
  it("records a deferred drift of a busy bot and does not block the sweep", async () => {
    const maintenance: BotMaintenancePort = {
      enter: async () => ({ state: "on", runningRuns: 0, owned: false }), // someone else's window
      status: async () => ({ state: "on", runningRuns: 1 }),
      exit: async () => {},
    };
    const driver = minimalDriver({
      templateDrift: async (spec) => ({
        drifted: true,
        fields: [{ field: "image", expected: spec.image, actual: "myrmidon-hermes:1.1.0" }],
      }),
    });
    const sweepDeps = deps(driver, { db, maintenance });
    const events: string[] = [];
    const listAgents = async () => {
      events.push("list");
      return [agent()];
    };
    const stop = startBotContainerReconciliation(listAgents, sweepDeps, { env: ENABLED });
    try {
      // Wait for the first tick to run its course (poll the record).
      let doc = await readBotRolloutDeferredDocument(db);
      for (let i = 0; i < 100 && doc.records.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        doc = await readBotRolloutDeferredDocument(db);
      }
      expect(doc.records).toHaveLength(1);
      const record = doc.records[0];
      expect(record.botKey).toBe("agent-a");
      expect(record.agentId).toBe("agent-a");
      expect(record.targetImage).toBe("myrmidon-hermes:1.1.0"); // the card's own image
      expect(record.attempts).toBe(0);
      expect(record.lastReason).toContain("did not open");
      // The sweep finished its pass despite the deferred bot, and the busy
      // bot was not retried by the watcher (the busy gate held — the bot
      // still reports running work), so the record kept attempts at 0.
      expect(events).toContain("list");
    } finally {
      stop();
    }
  });

  // (b) The bot freed up: the watcher applies the deferred drift — the
  // container is recreated with the card's image and the record is gone. No
  // new deploy happened: the watcher drove the regular apply. Deterministic:
  // phase 1 defers through applyBotContainerNow directly (no sweep timing),
  // phase 2 runs the watcher with the bot free.
  it("applies the deferred drift on a later pass once the bot is idle and removes the record", async () => {
    let running = 1;
    let owned = false;
    let appliedImage = "old";
    const maintenance: BotMaintenancePort = {
      enter: async () => ({ state: "on", runningRuns: running, owned }),
      status: async () => ({ state: owned ? "on" : "off", runningRuns: running }),
      exit: async () => {},
    };
    const recreated: string[] = [];
    const driver = minimalDriver({
      templateDrift: async (spec) => ({
        drifted: spec.image !== appliedImage,
        fields: spec.image === appliedImage ? [] : [{ field: "image", expected: spec.image, actual: appliedImage }],
      }),
      recreate: async (spec) => {
        recreated.push(spec.image);
        appliedImage = spec.image;
      },
    });
    const rt = deps(driver, { db, maintenance, readAgent: async () => agent() });

    // Phase 1: the busy bot defers, and the record is written (item 1).
    // force:true — the freshness reuse of earlier tests in this file (the
    // stamps are process-wide) would otherwise answer this pass without
    // running it.
    const first = await applyBotContainerNow(agent(), rt, { env: ENABLED, force: true });
    expect(first.kind).toBe("deferred");
    expect(recreated).toHaveLength(0);
    const afterDefer = await readBotRolloutDeferredDocument(db);
    expect(afterDefer.records).toHaveLength(1);
    expect(afterDefer.records[0].botKey).toBe("agent-a");

    // Phase 2: the bot's turn ended. The watcher (the sweep's own retry step)
    // applies the drift through the regular apply and removes the record.
    running = 0;
    owned = true;
    await runDeferredRolloutWatcher(db, {
      maintenance,
      applyNow: (a, opts) => applyBotContainerNow(a, rt, { env: ENABLED, force: opts.force }),
      readAgent: async () => agent(),
      env: ENABLED,
    });
    expect(recreated).toEqual(["myrmidon-hermes:1.1.0"]);
    expect((await readBotRolloutDeferredDocument(db)).records).toHaveLength(0);
  });

  // (c) The soft timeout: a record older than MAX_WAIT is retried WITHOUT
  // the busy gate — applyNow is called even though the bot still reports
  // running work — and the retry path carries no run interruption (the apply
  // itself is the regular pause-and-apply: drain, never interrupt).
  it("retries without the busy gate after MYRMIDON_BOT_ROLLOUT_DEFERRED_MAX_WAIT_SEC, without interrupting runs", async () => {
    const startedAt = Date.now();
    const record = makeRecord({ firstDeferredAt: new Date(startedAt - 3700_000).toISOString() });
    const doc = upsertBotRolloutDeferredRecord(
      emptyBotRolloutDeferredDocument(),
      { botKey: record.botKey, agentId: record.agentId, targetImage: record.targetImage, reason: record.lastReason, attempts: record.attempts },
      new Date(record.firstDeferredAt),
    );
    await db.insert(instanceSettings).values({
      singletonKey: "default",
      general: { [BOT_ROLLOUT_DEFERRED_GENERAL_KEY]: doc },
      experimental: {},
    });

    let statusCalls = 0;
    const maintenance: BotMaintenancePort = {
      enter: async () => ({ state: "on" as const, runningRuns: 0, owned: true }),
      status: async () => {
        statusCalls++;
        return { state: "off" as const, runningRuns: 1 }; // still busy
      },
      exit: async () => {},
    };
    const applyCalls: Array<{ agentId: string; force: boolean }> = [];
    const activity: Array<{ level: string; message: string }> = [];
    await runDeferredRolloutWatcher(db, {
      maintenance,
      activity: { record: (entry) => void activity.push({ level: entry.level, message: entry.message }) },
      applyNow: async (a, opts) => {
        applyCalls.push({ agentId: a.agentId, force: opts.force });
        return { kind: "deferred", reason: "the bot owner is in a chat conversation; the profile update is deferred to a later pass" };
      },
      readAgent: async () => agent(),
      env: { ...ENABLED, [BOT_ROLLOUT_DEFERRED_MAX_WAIT_ENV]: "3600" },
    });

    // The soft timeout is past (3700s > 3600s): the apply went out even
    // though the bot reports running work — and the busy signal was not even
    // consulted (an ungated retry does not need it).
    expect(applyCalls).toEqual([{ agentId: "agent-a", force: true }]);
    expect(statusCalls).toBe(0);
    // The retry deferred again (the reconciler drains; the turn is long): the
    // record stays with the attempt counted — no interruption anywhere in the
    // path (nothing here can cancel a run; the apply is reconcileBot's
    // pause-and-apply).
    const after = await readBotRolloutDeferredDocument(db);
    expect(after.records).toHaveLength(1);
    expect(after.records[0].attempts).toBe(1);
    expect(after.records[0].lastReason).toContain("chat");
    expect(activity.some((e) => e.level === "error")).toBe(false);
  });

  // (c2) Under the max wait the busy gate holds: a busy bot is NOT retried.
  it("does not retry a busy bot before the max wait", async () => {
    const record = makeRecord({ firstDeferredAt: new Date(Date.now() - 60_000).toISOString() });
    const doc = upsertBotRolloutDeferredRecord(
      emptyBotRolloutDeferredDocument(),
      { botKey: record.botKey, agentId: record.agentId, targetImage: record.targetImage, reason: record.lastReason, attempts: record.attempts },
      new Date(record.firstDeferredAt),
    );
    await db.insert(instanceSettings).values({
      singletonKey: "default",
      general: { [BOT_ROLLOUT_DEFERRED_GENERAL_KEY]: doc },
      experimental: {},
    });
    const maintenance: BotMaintenancePort = {
      enter: async () => ({ state: "on", runningRuns: 1, owned: false }),
      status: async () => ({ state: "on", runningRuns: 1 }),
      exit: async () => {},
    };
    let applyCalls = 0;
    await runDeferredRolloutWatcher(db, {
      maintenance,
      applyNow: async () => {
        applyCalls++;
        return { kind: "unchanged" };
      },
      readAgent: async () => agent(),
      env: { ...ENABLED, [BOT_ROLLOUT_DEFERRED_MAX_WAIT_ENV]: "3600" },
    });
    expect(applyCalls).toBe(0);
    const after = await readBotRolloutDeferredDocument(db);
    expect(after.records).toHaveLength(1); // still waiting
  });

  // (d) The backstop: a record older than 4× the max wait is retired with an
  // error event and an audit call — it does not retry forever.
  it("retires a record that outlived the bounded grace, with an audit event", async () => {
    const record = makeRecord({
      firstDeferredAt: new Date(Date.now() - 5 * 3600_000).toISOString(),
      attempts: 41,
    });
    const doc = upsertBotRolloutDeferredRecord(
      emptyBotRolloutDeferredDocument(),
      { botKey: record.botKey, agentId: record.agentId, targetImage: record.targetImage, reason: record.lastReason, attempts: record.attempts },
      new Date(record.firstDeferredAt),
    );
    expect(doc.records[0].attempts).toBe(41); // a same-image upsert keeps the record's attempts
    await db.insert(instanceSettings).values({
      singletonKey: "default",
      general: { [BOT_ROLLOUT_DEFERRED_GENERAL_KEY]: doc },
      experimental: {},
    });
    const maintenance: BotMaintenancePort = {
      enter: async () => ({ state: "on", runningRuns: 0, owned: true }),
      status: async () => ({ state: "off", runningRuns: 0 }),
      exit: async () => {},
    };
    let applyCalls = 0;
    const activity: Array<{ level: string; message: string; details?: Record<string, unknown> }> = [];
    const audits: Array<{ action: string; agentId: string; companyId: string }> = [];
    await runDeferredRolloutWatcher(db, {
      maintenance,
      activity: { record: (entry) => void activity.push(entry) },
      applyNow: async () => {
        applyCalls++;
        return { kind: "unchanged" };
      },
      readAgent: async () => agent(),
      audit: async (entry) => {
        audits.push({ action: entry.action, agentId: entry.agentId, companyId: entry.companyId });
      },
      companyIdOf: async () => "company-a",
      env: { ...ENABLED, [BOT_ROLLOUT_DEFERRED_MAX_WAIT_ENV]: "3600" },
    });
    expect(applyCalls).toBe(0); // no further retry — the record is retired
    const after = await readBotRolloutDeferredDocument(db);
    expect(after.records).toHaveLength(0);
    const errorEvent = activity.find((e) => e.level === "error");
    expect(errorEvent?.message).toContain("did not converge");
    expect(errorEvent?.details?.attempts).toBe(41);
    expect(audits).toEqual([{ action: "myrmidon.bot_rollout.deferred_retired", agentId: "agent-a", companyId: "company-a" }]);
  });

  // A converging pass removes the record (a card image changed back mid-deferral
  // converges exactly this way — the sweep's plain pass, no watcher involved).
  it("removes the record when a regular pass converges", async () => {
    const record = makeRecord();
    const doc = upsertBotRolloutDeferredRecord(
      emptyBotRolloutDeferredDocument(),
      { botKey: record.botKey, agentId: record.agentId, targetImage: record.targetImage, reason: record.lastReason, attempts: record.attempts },
      new Date(record.firstDeferredAt),
    );
    await db.insert(instanceSettings).values({
      singletonKey: "default",
      general: { [BOT_ROLLOUT_DEFERRED_GENERAL_KEY]: doc },
      experimental: {},
    });
    // The card now matches the container: unchanged. force:true — the
    // freshness reuse of earlier tests in this file would otherwise answer
    // the pass without running it (the stamps are process-wide).
    const outcome = await applyBotContainerNow(agent(), deps(minimalDriver(), { db }), { env: ENABLED, force: true });
    expect(outcome).toEqual({ kind: "unchanged" });
    expect((await readBotRolloutDeferredDocument(db)).records).toHaveLength(0);
  });
});

describe("myrmidon(BOT-ROLLOUT) settings", () => {
  it("defaults the deferred max wait to 3600s and bounds garbage", () => {
    expect(DEFAULT_BOT_ROLLOUT_DEFERRED_MAX_WAIT_SEC).toBe(3600);
    expect(readBotRolloutDeferredMaxWaitSec({})).toBe(3600);
    expect(readBotRolloutDeferredMaxWaitSec({ [BOT_ROLLOUT_DEFERRED_MAX_WAIT_ENV]: "600" })).toBe(600);
    expect(readBotRolloutDeferredMaxWaitSec({ [BOT_ROLLOUT_DEFERRED_MAX_WAIT_ENV]: "junk" })).toBe(3600);
    expect(readBotRolloutDeferredMaxWaitSec({ [BOT_ROLLOUT_DEFERRED_MAX_WAIT_ENV]: "5" })).toBe(3600);
    expect(readBotRolloutDeferredMaxWaitSec({ [BOT_ROLLOUT_DEFERRED_MAX_WAIT_ENV]: "99999999" })).toBe(3600);
  });
});
