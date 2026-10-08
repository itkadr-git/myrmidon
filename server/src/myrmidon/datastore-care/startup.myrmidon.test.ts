// myrmidon(DBC-4): tests for the hourly job and its retention.
//
// The project asks for 24 snapshots a day and a 90-day retention of the
// module's own tables, so the job is asserted on exactly that: one pass per
// interval, an immediate catch-up when the newest snapshot is already stale,
// no second pass while one is in flight, and a prune that happens even when a
// collection failed. A failing target must not stop the pass: it lands in
// `errors` and the next target is collected.
//
// Neutral data only: example.com, 192.0.2.0/24.

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DatastoreTarget } from "./domain.js";
import { readDatastoreCareSettings } from "./settings.js";
import type { DatastoreCareStore, DatastoreSnapshotRecord } from "./store.js";
import type { DatastoreCareService } from "./service.js";
import { createDatastoreCareJob } from "./startup.js";

const NOW = new Date("2026-10-08T05:00:00.000Z");
const BOARD: DatastoreTarget = {
  key: "board",
  engine: "postgres",
  title: "База доски",
  implicit: true,
  dbId: null,
  connectionRef: "board-primary",
};

function snapshotRecord(id: string, capturedAt: Date, sizeBytes = 1000): DatastoreSnapshotRecord {
  return {
    id,
    datastoreKey: "board",
    capturedAt: capturedAt.toISOString(),
    sizeBytes,
    toastBytes: 0,
    indexBytes: 0,
    serverVersion: "PostgreSQL 18.0",
    payload: null as never,
    createdAt: capturedAt.toISOString(),
  };
}

function harness(
  options: {
    latest?: DatastoreSnapshotRecord | null;
    captureError?: Error | null;
    pruneSnapshots?: number;
    pruneReports?: number;
    targets?: readonly DatastoreTarget[];
    enabled?: boolean;
    now?: Date;
  } = {},
) {
  const now = () => options.now ?? NOW;
  const captured: string[] = [];
  const pruned: Date[] = [];
  const logs: string[] = [];

  const service = {
    captureSnapshot: async (key: string) => {
      captured.push(key);
      if (options.captureError) throw options.captureError;
      return { snapshot: snapshotRecord(`snap-${key}-${captured.length}`, now()), target: BOARD };
    },
  } as unknown as DatastoreCareService;

  const store = {
    latestSnapshot: async () => options.latest ?? null,
    pruneSnapshotsBefore: async (cutoff: Date) => {
      pruned.push(cutoff);
      return options.pruneSnapshots ?? 0;
    },
    pruneAuditReportsBefore: async () => options.pruneReports ?? 0,
  } as unknown as DatastoreCareStore;

  const settings = readDatastoreCareSettings({
    ...(options.enabled === false ? { MYRMIDON_DATASTORE_CARE_ENABLED: "0" } : {}),
    MYRMIDON_DATASTORE_CARE_RETENTION_DAYS: "90",
  } as NodeJS.ProcessEnv);

  const job = createDatastoreCareJob({
    service,
    store,
    settings,
    targets: () => options.targets ?? [BOARD],
    now,
    log: (message: string) => logs.push(message),
  });

  return { job, captured, pruned, logs };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("myrmidon(DBC-4) datastore-care job", () => {
  it("takes one snapshot per target and prunes with the retention cutoff", async () => {
    const { job, captured, pruned, logs } = harness({ pruneSnapshots: 3, pruneReports: 1 });

    const run = await job.runOnce("hourly");

    expect(run).not.toBeNull();
    expect(run!.reason).toBe("hourly");
    expect(run!.startedAt).toBe(NOW.toISOString());
    expect(run!.finishedAt).toBe(NOW.toISOString());
    expect(captured).toEqual(["board"]);
    expect(run!.snapshots).toEqual([{ key: "board", id: "snap-board-1", sizeBytes: 1000 }]);
    expect(run!.prunedSnapshots).toBe(3);
    expect(run!.prunedAuditReports).toBe(1);
    expect(run!.errors).toEqual([]);
    expect(pruned[0]!.toISOString()).toBe(
      new Date(NOW.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString(),
    );
    expect(logs.join("\n")).toContain("snapshot board");
  });

  it("records a failing target and keeps going, and still prunes", async () => {
    const { job, captured, pruned } = harness({
      captureError: new Error("canceling statement due to statement timeout"),
    });

    const run = await job.runOnce("hourly");

    expect(captured).toEqual(["board"]);
    expect(run!.snapshots).toEqual([]);
    expect(run!.errors).toEqual([
      { key: "board", message: "canceling statement due to statement timeout" },
    ]);
    // Retention is not a side effect of a successful collection.
    expect(pruned).toHaveLength(1);
  });

  it("refuses a second pass while one is in flight", async () => {
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const captured: string[] = [];
    const service = {
      captureSnapshot: async (key: string) => {
        captured.push(key);
        await blocked;
        return { snapshot: snapshotRecord("snap-1", NOW), target: BOARD };
      },
    } as unknown as DatastoreCareService;
    const store = {
      latestSnapshot: async () => null,
      pruneSnapshotsBefore: async () => 0,
      pruneAuditReportsBefore: async () => 0,
    } as unknown as DatastoreCareStore;
    const job = createDatastoreCareJob({
      service,
      store,
      settings: readDatastoreCareSettings({} as NodeJS.ProcessEnv),
      targets: () => [BOARD],
      now: () => NOW,
    });

    const first = job.runOnce("hourly");
    expect(job.isRunning()).toBe(true);
    const second = await job.runOnce("hourly");
    expect(second).toBeNull();
    release();
    const done = await first;
    expect(done!.snapshots).toHaveLength(1);
    expect(captured).toEqual(["board"]);
    expect(job.isRunning()).toBe(false);
  });

  it("schedules one pass per interval and stops on stop()", async () => {
    vi.useFakeTimers();
    // A fresh snapshot keeps the startup catch-up out of this test: it measures
    // the interval, and the catch-up has its own tests below.
    const { job, captured } = harness({
      latest: snapshotRecord("recent", new Date(NOW.getTime() - 60_000)),
    });

    job.start();
    expect(job.intervalMs).toBe(3_600_000);
    expect(captured).toEqual([]);

    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(captured).toEqual(["board"]);

    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(captured).toEqual(["board", "board"]);

    job.stop();
    await vi.advanceTimersByTimeAsync(3 * 3_600_000);
    expect(captured).toEqual(["board", "board"]);
  });

  it("catches up at start when the newest snapshot is already stale", async () => {
    vi.useFakeTimers();
    const stale = harness({
      latest: snapshotRecord("old", new Date(NOW.getTime() - 2 * 3_600_000)),
    });

    stale.job.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(stale.captured).toEqual(["board"]);
    stale.job.stop();
  });

  it("does not collect twice when the newest snapshot is fresh", async () => {
    vi.useFakeTimers();
    const fresh = harness({
      latest: snapshotRecord("recent", new Date(NOW.getTime() - 60_000)),
    });

    fresh.job.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fresh.captured).toEqual([]);
    fresh.job.stop();
  });

  it("does not schedule anything when the module is switched off", async () => {
    vi.useFakeTimers();
    const { job, captured } = harness({ enabled: false });

    job.start();
    await vi.advanceTimersByTimeAsync(10 * 3_600_000);
    expect(captured).toEqual([]);
    job.stop();
  });

  it("skips the startup catch-up when the newest snapshot cannot be read", async () => {
    vi.useFakeTimers();
    const service = {
      captureSnapshot: async () => {
        throw new Error("unreachable");
      },
    } as unknown as DatastoreCareService;
    const store = {
      latestSnapshot: async () => {
        throw new Error("connection terminated unexpectedly");
      },
      pruneSnapshotsBefore: async () => 0,
      pruneAuditReportsBefore: async () => 0,
    } as unknown as DatastoreCareStore;
    const logs: string[] = [];
    const job = createDatastoreCareJob({
      service,
      store,
      settings: readDatastoreCareSettings({} as NodeJS.ProcessEnv),
      targets: () => [BOARD],
      now: () => NOW,
      log: (message: string) => logs.push(message),
    });

    job.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(logs.join("\n")).toContain("startup catch-up skipped");
    job.stop();
  });
});