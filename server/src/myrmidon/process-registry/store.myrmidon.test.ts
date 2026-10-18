// server/src/myrmidon/process-registry/store.myrmidon.test.ts
//
// myrmidon(1.6.6 PROCS-0.1, design BOARD-PROCESSES §5.1): the registry's write
// path — what the store hands the driver, and what the column actually accepts.
//
// The other registry tests drive the store over an in-memory fake, so none of
// them can notice that the value the pulse measures does not fit the column it
// is written into: `monitorEventLoopDelay` reports nanoseconds, the pulse turns
// the p50 into (fractional) milliseconds, and `board_processes.event_loop_lag_ms`
// is int4 — Postgres answers 22P02 for a fraction, `tick()` reports the failure
// through `onError` and keeps ticking, so the row (and with it the whole
// «Процессы» panel) stays empty on a healthy board instead of failing loudly.
//
// The first block pins the value the driver receives (runs everywhere, no
// cluster needed); the second runs the real store and the real pulse cadence
// against embedded Postgres, which is the only place the failure is visible.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { boardLeases, boardProcesses, createDb, type Db } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import {
  disablePulseEventLoopMonitor,
  enablePulseEventLoopMonitor,
} from "../monitoring/metrics/process-metrics.js";
import { resolveBoardProcessIdentity, type BoardProcessIdentity } from "./domain.js";
import { createBoardProcessPulse } from "./pulse.js";
import { createBoardLeaseStore } from "./leases.js";
import { createBoardProcessStore } from "./store.js";

type CapturedRow = Record<string, unknown>;

/** A `Db` whose only job is to hand the written row back to the test, so the
 * assertion is about what the driver — and therefore Postgres — would receive. */
function createCapturingDb(captured: CapturedRow[]): Db {
  return {
    insert: () => ({
      values: (row: CapturedRow) => {
        captured.push(row);
        return { onConflictDoUpdate: async () => undefined };
      },
    }),
  } as unknown as Db;
}

/** Identity of a process that does not exist: a fresh boot id per call, so rows
 * of one test cannot answer for another. */
type IdentityOptions = Parameters<typeof resolveBoardProcessIdentity>[0];

function testIdentity(overrides: Partial<IdentityOptions> = {}): BoardProcessIdentity {
  return resolveBoardProcessIdentity({
    version: "1.6.6+0.git.test",
    bootId: randomUUID(),
    pid: 4242,
    hostname: "board-test-host",
    container: null,
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    apiPort: 3130,
    ...overrides,
  });
}

describe("board process store writes whole milliseconds (myrmidon PROCS-0.1)", () => {
  it.each([
    [12.5, 13],
    [12.4, 12],
    [8.4, 8],
    [0.49, 0],
    [99.9, 100],
    [7, 7],
  ])("writes a measured %s ms as %s into the int4 column", async (lagMs: number, expected: number) => {
    const captured: CapturedRow[] = [];
    const store = createBoardProcessStore(createCapturingDb(captured));

    await store.heartbeat(
      testIdentity(),
      { eventLoopLagMs: lagMs, rssBytes: 1024 },
      new Date("2026-01-01T00:00:00.000Z"),
    );

    expect(captured).toHaveLength(1);
    expect(captured[0].eventLoopLagMs).toBe(expected);
    expect(Number.isInteger(captured[0].eventLoopLagMs)).toBe(true);
  });

  it("writes a reading that is not a finite number as no measurement", async () => {
    for (const lagMs of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const captured: CapturedRow[] = [];
      const store = createBoardProcessStore(createCapturingDb(captured));

      await store.heartbeat(
        testIdentity(),
        { eventLoopLagMs: lagMs, rssBytes: 1024 },
        new Date("2026-01-01T00:00:00.000Z"),
      );

      expect(captured[0].eventLoopLagMs).toBeNull();
    }
  });

  it("keeps a missing measurement missing and the RSS bytes as they are", async () => {
    const captured: CapturedRow[] = [];
    const store = createBoardProcessStore(createCapturingDb(captured));

    await store.heartbeat(
      testIdentity(),
      { eventLoopLagMs: null, rssBytes: 4_294_967_296 },
      new Date("2026-01-01T00:00:00.000Z"),
    );

    expect(captured[0].eventLoopLagMs).toBeNull();
    expect(captured[0].rssBytes).toBe(4_294_967_296);
  });

  it("writes whole milliseconds on the refresh path as well", async () => {
    const captured: CapturedRow[] = [];
    const updated: CapturedRow[] = [];
    const db = {
      insert: () => ({
        values: (row: CapturedRow) => {
          captured.push(row);
          return {
            onConflictDoUpdate: async ({ set }: { set: CapturedRow }) => {
              updated.push(set);
            },
          };
        },
      }),
    } as unknown as Db;

    await createBoardProcessStore(db).heartbeat(
      testIdentity(),
      { eventLoopLagMs: 5.7, rssBytes: 2048 },
      new Date("2026-01-01T00:00:00.000Z"),
    );

    expect(captured[0].eventLoopLagMs).toBe(6);
    expect(updated[0].eventLoopLagMs).toBe(6);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("board process store against Postgres (myrmidon PROCS-0.1)", () => {
  const t0 = new Date("2026-01-01T00:00:00.000Z");
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-board-processes-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    disablePulseEventLoopMonitor();
    if (db) await db.delete(boardProcesses);
    if (db) await db.delete(boardLeases);
    if (tempDb) await tempDb.cleanup();
  });

  it("accepts a fractional measurement and stores it as whole milliseconds", async () => {
    const store = createBoardProcessStore(db);
    const identity = testIdentity();

    await store.heartbeat(identity, { eventLoopLagMs: 12.5, rssBytes: 4096 }, t0);

    const row = (await store.listProcesses()).find((candidate) => candidate.bootId === identity.bootId);
    expect(row).toBeDefined();
    expect(row!.eventLoopLagMs).toBe(13);
    expect(row!.rssBytes).toBe(4096);
  });

  it("refreshes its own row on the next pulse instead of failing the conflict", async () => {
    const store = createBoardProcessStore(db);
    const identity = testIdentity();
    const next = new Date(t0.getTime() + 10_000);

    await store.heartbeat(identity, { eventLoopLagMs: 3.2, rssBytes: 1024 }, t0);
    await store.heartbeat(identity, { eventLoopLagMs: 4.9, rssBytes: 2048 }, next);

    const rows = (await store.listProcesses()).filter((candidate) => candidate.bootId === identity.bootId);
    expect(rows).toHaveLength(1);
    expect(rows[0].eventLoopLagMs).toBe(5);
    expect(rows[0].rssBytes).toBe(2048);
    expect(rows[0].lastSeenAt.getTime()).toBe(next.getTime());
  });

  it("lands a row for the real pulse path: observation, heartbeat, row", async () => {
    enablePulseEventLoopMonitor();
    const store = createBoardProcessStore(db);
    const identity = testIdentity();
    const pulse = createBoardProcessPulse({ store, identity, reap: false });

    await pulse.tick();

    expect(pulse.running).toBe(false);
    const row = (await store.listProcesses()).find((candidate) => candidate.bootId === identity.bootId);
    expect(row).toBeDefined();
    expect(row!.rssBytes).toBeGreaterThan(0);
    if (row!.eventLoopLagMs !== null) {
      expect(Number.isInteger(row!.eventLoopLagMs)).toBe(true);
    }
  });

  it("reaps a row whose last pulse is older than the window and keeps the fresh one", async () => {
    const store = createBoardProcessStore(db);
    const dead = testIdentity();
    const live = testIdentity();
    const at = new Date(t0.getTime() + 3 * 60_000);

    await store.heartbeat(dead, { eventLoopLagMs: 1, rssBytes: 1024 }, t0);
    await store.heartbeat(live, { eventLoopLagMs: 1, rssBytes: 1024 }, at);

    const pulse = createBoardProcessPulse({ store, identity: live, reap: true });
    await pulse.reapStale(at);

    const bootIds = (await store.listProcesses()).map((row) => row.bootId);
    expect(bootIds).toContain(live.bootId);
    expect(bootIds).not.toContain(dead.bootId);
  });

  it("reads the lease rows by name, with epoch as a number and an unheld lease as nulls", async () => {
    await db.insert(boardLeases).values([
      {
        name: "scheduler",
        holderBootId: "boot-a",
        epoch: 12,
        acquiredAt: t0,
        expiresAt: new Date(t0.getTime() + 30_000),
      },
      { name: "backup" },
    ]);

    const leases = await createBoardLeaseStore(db).listLeases();

    expect(leases).toEqual([
      { name: "backup", holderBootId: null, epoch: 0, acquiredAt: null, expiresAt: null },
      {
        name: "scheduler",
        holderBootId: "boot-a",
        epoch: 12,
        acquiredAt: t0,
        expiresAt: new Date(t0.getTime() + 30_000),
      },
    ]);
  });
});
