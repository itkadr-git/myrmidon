// myrmidon(1.6.5-PROCS-T02): the lane counters — busy seconds of a labelled
// unit of work, and the DB queries each lane issues.

import { afterEach, describe, expect, it } from "vitest";
import { setDbQueryObserver, withQueryAccounting } from "@paperclipai/db";
import { currentLane, withLane } from "./lane-context.js";
import {
  API_LANE,
  TICK_LANE,
  runInLane,
  startLaneQueryAccounting,
} from "./lane-metrics.js";
import { laneCountersSnapshot, resetProcessMetricsState } from "./process-metrics.js";

type WrappedSql = ReturnType<typeof withQueryAccounting>;

/** The smallest client the query accounting touches: unsafe + transactions. */
function fakeSql() {
  const issued: string[] = [];
  const scoped = {
    unsafe(query: string) {
      issued.push(query);
      return Promise.resolve([]);
    },
  };
  const sql = {
    ...scoped,
    begin: (fn: (tx: typeof scoped) => Promise<unknown>) => fn(scoped),
    savepoint: (fn: (tx: typeof scoped) => Promise<unknown>) => fn(scoped),
  };
  return { sql, issued };
}

afterEach(() => {
  setDbQueryObserver(null);
  resetProcessMetricsState();
});

describe("lane metrics: busy seconds", () => {
  it("adds the wall time of a unit of work to its lane and labels the work", async () => {
    await runInLane(TICK_LANE, async () => {
      expect(currentLane()).toBe(TICK_LANE);
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    const rows = laneCountersSnapshot();
    expect(rows.map((row) => row.lane)).toEqual([TICK_LANE]);
    expect(rows[0]?.busySeconds).toBeGreaterThan(0);
    expect(rows[0]?.queries).toBe(0);
  });

  it("measures a failed unit of work as well, and restores the context", async () => {
    await expect(
      runInLane("execution-control", async () => {
        throw new Error("sweep failed");
      }),
    ).rejects.toThrow("sweep failed");
    const rows = laneCountersSnapshot();
    expect(rows.map((row) => row.lane)).toEqual(["execution-control"]);
    expect(rows[0]?.busySeconds).toBeGreaterThan(0);
    expect(currentLane()).toBe("unlabeled");
  });

  it("keeps separate counters per lane", async () => {
    await runInLane(TICK_LANE, () => undefined);
    await runInLane(API_LANE, () => undefined);
    expect(laneCountersSnapshot().map((row) => row.lane)).toEqual([API_LANE, TICK_LANE]);
  });
});

describe("lane metrics: db query accounting", () => {
  it("counts a query into the lane that issued it, unlabeled outside any lane", async () => {
    startLaneQueryAccounting();
    const { sql, issued } = fakeSql();
    const wrapped = withQueryAccounting(sql as unknown as WrappedSql);

    await withLane("some-lane", async () => {
      await wrapped.unsafe("select 1");
    });
    await wrapped.unsafe("select 2");

    expect(issued).toEqual(["select 1", "select 2"]);
    expect(laneCountersSnapshot()).toEqual([
      { lane: "some-lane", queries: 1, busySeconds: 0 },
      { lane: "unlabeled", queries: 1, busySeconds: 0 },
    ]);
  });

  it("counts the queries of a transaction into the lane that opened it", async () => {
    startLaneQueryAccounting();
    const { sql, issued } = fakeSql();
    const wrapped = withQueryAccounting(sql as unknown as WrappedSql);

    await runInLane(TICK_LANE, async () => {
      // The driver types the callback's client as a transaction client; the
      // test only needs the accounting face, so reach it through the cast the
      // wrapper itself uses.
      await wrapped.begin(async (tx) => {
        const scoped = tx as unknown as WrappedSql;
        await scoped.unsafe("select 1");
        await scoped.unsafe("select 2");
      });
    });

    expect(issued).toEqual(["select 1", "select 2"]);
    const tick = laneCountersSnapshot().find((row) => row.lane === TICK_LANE);
    expect(tick?.queries).toBe(2);
  });

  it("counts nothing while no observer is installed", async () => {
    const { sql, issued } = fakeSql();
    const wrapped = withQueryAccounting(sql as unknown as WrappedSql);
    await wrapped.unsafe("select 1");
    expect(issued).toEqual(["select 1"]);
    expect(laneCountersSnapshot()).toEqual([]);
  });
});