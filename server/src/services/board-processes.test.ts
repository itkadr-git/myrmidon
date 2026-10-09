// myrmidon(PROCS-0.1): the pulse service unit tests. The DB is faked at the
// drizzle chain level; the advisory-lock result flows through the execute()
// stub, so the leader/single paths stay honest without postgres.

import { afterEach, describe, expect, it, vi } from "vitest";
import { boardProcessPulseService } from "./board-processes.js";

type ExecutedCall = { query: unknown };

function fakeDb(handlers: { executeRows?: unknown[] } = {}) {
  const inserts: Record<string, unknown>[] = [];
  const conflictSets: Record<string, unknown>[] = [];
  const updates: { set: Record<string, unknown> }[] = [];
  const deletes: unknown[] = [];
  const executed: ExecutedCall[] = [];
  const transactions: number[] = [];

  const db = {
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        onConflictDoUpdate: (c: { set: Record<string, unknown> }) => {
          inserts.push(v);
          conflictSets.push(c.set);
          return Promise.resolve();
        },
      }),
    }),
    delete: () => ({
      where: (w: unknown) => {
        deletes.push(w);
        return Promise.resolve();
      },
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      transactions.push(1);
      const tx = {
        execute: (q: unknown) => {
          executed.push({ query: q });
          return Promise.resolve(handlers.executeRows ?? [{ acquired: true }]);
        },
      };
      return fn(tx);
    },
    execute: (q: unknown) => {
      executed.push({ query: q });
      return Promise.resolve(handlers.executeRows ?? [{ acquired: true }]);
    },
  };
  return { db, inserts, conflictSets, updates, deletes, executed, transactions };
}

const OPTS = { role: "api", apiPort: 3100, version: "1.6.6-test" };

describe("boardProcessPulseService", () => {
  let service: ReturnType<typeof boardProcessPulseService> | null = null;
  afterEach(async () => {
    await service?.stop();
    service = null;
    vi.useRealTimers();
  });

  it("start writes the row with role/pid/host/port/version and the first pulse metrics", async () => {
    const { db, inserts, conflictSets } = fakeDb();
    service = boardProcessPulseService(db as never, OPTS);
    await service.start();
    expect(inserts).toHaveLength(1);
    const row = inserts[0];
    expect(row.role).toBe("api");
    expect(row.apiPort).toBe(3100);
    expect(row.version).toBe("1.6.6-test");
    expect(typeof row.pid).toBe("number");
    expect(typeof row.hostname).toBe("string");
    expect(row.bootId).toBe(service.identity.bootId);
    // The conflict set touches only the moving parts; started_at is immutable.
    expect(conflictSets[0]).toHaveProperty("lastSeenAt");
    expect(conflictSets[0]).toHaveProperty("eventLoopLagMs");
    expect(conflictSets[0]).toHaveProperty("rssBytes");
    expect(conflictSets[0]).not.toHaveProperty("startedAt");
    expect(row.lastSeenAt).toBeInstanceOf(Date);
    expect(row.rssBytes).toBeGreaterThan(0);
  });

  it("uses the identity it is given (the metrics labels match the row)", async () => {
    const { db, inserts } = fakeDb();
    service = boardProcessPulseService(db as never, {
      ...OPTS,
      bootId: "boot-fixed",
      role: "scheduler",
      hostname: "host-a",
      container: "abcdef123456",
    });
    await service.start();
    expect(service.identity.bootId).toBe("boot-fixed");
    expect(service.identity.role).toBe("scheduler");
    expect(service.identity.hostname).toBe("host-a");
    expect(service.identity.container).toBe("abcdef123456");
    expect(inserts[0].bootId).toBe("boot-fixed");
    expect(inserts[0].role).toBe("scheduler");
    expect(inserts[0].container).toBe("abcdef123456");
  });

  it("pulses on the interval: a new upsert with fresh metrics, same boot id", async () => {
    vi.useFakeTimers();
    const { db, inserts, transactions } = fakeDb();
    service = boardProcessPulseService(db as never, { ...OPTS, pulseIntervalMs: 10_000 });
    await service.start();
    expect(inserts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    // Each tick upserts the row and attempts the stale sweep.
    expect(inserts.length).toBe(2);
    expect(transactions.length).toBeGreaterThanOrEqual(1);
    expect(inserts[1].bootId).toBe(inserts[0].bootId);
  });

  it("the stale sweep deletes only when the advisory lock is taken", async () => {
    vi.useFakeTimers();
    const { db, executed } = fakeDb();
    service = boardProcessPulseService(db as never, { ...OPTS, pulseIntervalMs: 10_000 });
    await service.start();
    await vi.advanceTimersByTimeAsync(10_000);
    // execute() is called twice per sweep: try-lock then the delete. With the
    // lock taken the pair is (lock, delete); count the delete half.
    expect(executed.length).toBeGreaterThanOrEqual(2);

    const { db: db2, executed: executed2 } = fakeDb({ executeRows: [{ acquired: false }] });
    const other = boardProcessPulseService(db2 as never, { ...OPTS, pulseIntervalMs: 10_000 });
    await other.start();
    await vi.advanceTimersByTimeAsync(10_000);
    // Lock not taken → only the try-lock executes, never the delete.
    expect(executed2.length).toBe(1);
    await other.stop();
  });

  it("stop removes the row and stops the timers", async () => {
    vi.useFakeTimers();
    const { db, deletes, inserts } = fakeDb();
    service = boardProcessPulseService(db as never, { ...OPTS, pulseIntervalMs: 10_000 });
    await service.start();
    const s = service;
    service = null; // stopped by hand, once
    await s.stop();
    expect(deletes).toHaveLength(1);
    const insertsAtStop = inserts.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(inserts).toHaveLength(insertsAtStop);
  });

  it("a failing pulse is swallowed and logged, never thrown out of the timer", async () => {
    vi.useFakeTimers();
    const { db, inserts } = fakeDb();
    service = boardProcessPulseService(db as never, { ...OPTS, pulseIntervalMs: 10_000 });
    await service.start();
    expect(inserts).toHaveLength(1);
    // Break the insert for the next tick; the tick must still complete.
    const origInsert = db.insert;
    db.insert = () => {
      throw new Error("db gone");
    };
    await vi.advanceTimersByTimeAsync(10_000);
    expect(inserts).toHaveLength(1);
    db.insert = origInsert;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(inserts).toHaveLength(2);
  });

  it("the container field is present on the row (cgroup id in docker, null on a bare host)", async () => {
    const { db, inserts } = fakeDb();
    service = boardProcessPulseService(db as never, OPTS);
    await service.start();
    expect(inserts[0]).toHaveProperty("container");
  });
});
