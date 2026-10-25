// myrmidon(1.6.6 PROCS-0.3A): the load-lane contract of design OPE-5394 §1 П2.
//
// What these tests pin: a lane is the async context of the work, so it must
// survive an await and be lost after the scope; DB statements issued below a
// lane boundary belong to that lane and to nothing else (work outside every
// lane is `untagged`, the residue that proves the instrumentation is not
// pretending); a nested scope is attributed to the innermost lane only; and
// the exposition sees every lane even before it ran.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOARD_LANES,
  backgroundInterval,
  currentLane,
  enterLane,
  enterLaneIfUntagged,
  laneInterval,
  readLaneSample,
  recordLaneDbQuery,
  recordLaneExecution,
  resetLaneCounters,
  resolveLaneMetricsSource,
  runInLane,
  type BoardLaneSample,
} from "./lanes.js";

function laneRow(lane: string): BoardLaneSample {
  const row = readLaneSample().find((candidate) => candidate.lane === lane);
  if (!row) throw new Error(`lane ${lane} must always be reported`);
  return row;
}

describe("board load lanes", () => {
  beforeEach(() => {
    resetLaneCounters();
  });

  it("names exactly the lanes the design lists, residue last", () => {
    expect([...BOARD_LANES]).toEqual([
      "http_route",
      "heartbeat_tick",
      "execution_control",
      "chat_reconcile",
      "bot_reconcile",
      "run_supervision",
      "background_sweep",
      // The residue, not a lane the board schedules: work outside every lane
      // is reported here instead of being spread over the lanes.
      "untagged",
    ]);
  });

  it("reports every lane as zeros before any of them ran", () => {
    const sample = readLaneSample();
    expect(sample.map((row) => row.lane)).toEqual([...BOARD_LANES]);
    expect(sample.every((row) => row.dbQueries === 0 && row.busyMs === 0 && row.executions === 0)).toBe(true);
  });

  it("has a lane inside its scope and no lane outside it", () => {
    const inside = enterLane("http_route", () => currentLane());
    expect(inside).toBe("http_route");
    expect(currentLane()).toBeNull();
  });

  it("keeps the lane across await points below the boundary", async () => {
    const seen = await enterLane("bot_reconcile", async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return currentLane();
    });
    expect(seen).toBe("bot_reconcile");
  });

  it("counts a DB statement against the lane in force when it was issued", async () => {
    // The real seam is createDb({ onQuery }): the callback runs in the caller's
    // async context, which is what makes this attribution possible at all.
    const db = {
      execute: async (): Promise<unknown> => {
        recordLaneDbQuery();
        return [];
      },
    };

    await enterLane("execution_control", async () => {
      await db.execute();
      await db.execute();
    });
    await enterLane("chat_reconcile", () => db.execute());
    await db.execute(); // outside every lane
    recordLaneDbQuery(null); // explicit: nobody was in a lane

    expect(laneRow("execution_control").dbQueries).toBe(2);
    expect(laneRow("chat_reconcile").dbQueries).toBe(1);
    expect(laneRow("http_route").dbQueries).toBe(0);
  });

  it("counts wall time and executions per settled scope", () => {
    recordLaneExecution("heartbeat_tick", 10);
    recordLaneExecution("heartbeat_tick", 2.5);
    runInLane("heartbeat_tick", () => undefined);

    const row = laneRow("heartbeat_tick");
    expect(row.executions).toBe(3);
    expect(row.busyMs).toBeGreaterThanOrEqual(12.5);
  });

  it("attributes nested scopes to the innermost lane only", () => {
    runInLane("heartbeat_tick", () => {
      runInLane("http_route", () => {
        recordLaneDbQuery();
        return undefined;
      });
      recordLaneDbQuery();
      return undefined;
    });

    expect(laneRow("http_route").dbQueries).toBe(1);
    expect(laneRow("heartbeat_tick").dbQueries).toBe(1);
    expect(laneRow("http_route").executions).toBe(1);
    expect(laneRow("heartbeat_tick").executions).toBe(1);
  });

  it("enters the fallback lane only when nobody owns the context", () => {
    const fromRequest = enterLane("http_route", () => enterLaneIfUntagged("run_supervision", () => currentLane()));
    const fromNowhere = enterLaneIfUntagged("run_supervision", () => currentLane());

    expect(fromRequest).toBe("http_route");
    expect(fromNowhere).toBe("run_supervision");
    expect(currentLane()).toBeNull();
  });

  it("runs every interval pass in its lane and reports a rejected pass", async () => {
    vi.useFakeTimers();
    try {
      const failures: unknown[] = [];
      const timer = laneInterval(
        "chat_reconcile",
        1_000,
        async () => {
          recordLaneDbQuery();
          throw new Error("reconcile pass failed");
        },
        (error) => failures.push(error),
      );
      timer.unref?.();

      await vi.advanceTimersByTimeAsync(2_000);
      clearInterval(timer);

      expect(failures).toHaveLength(2);
      expect(laneRow("chat_reconcile").dbQueries).toBe(2);
      expect(laneRow("chat_reconcile").executions).toBe(2);
      expect(laneRow("chat_reconcile").busyMs).toBeGreaterThanOrEqual(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads the registry, a function source and a read() source alike", () => {
    recordLaneDbQuery("bot_reconcile");
    const fake: BoardLaneSample[] = [
      { lane: "bot_reconcile", dbQueries: 7, busyMs: 3, executions: 1 },
    ];

    expect(resolveLaneMetricsSource(null)()).toEqual(readLaneSample());
    expect(resolveLaneMetricsSource(undefined)().map((row) => row.lane)).toEqual([...BOARD_LANES]);
    expect(resolveLaneMetricsSource(() => fake)()).toEqual(fake);
    expect(resolveLaneMetricsSource({ read: () => fake })()).toEqual(fake);
  });

  it("counts a statement issued outside every lane as the residue, never as a named lane", () => {
    recordLaneDbQuery(null);
    const sample = readLaneSample();
    // §1 П2: work outside every lane is reported as `untagged` instead of being
    // spread over the lanes, so the lane totals still add up to the process.
    expect(sample.find((row) => row.lane === "untagged")?.dbQueries).toBe(1);
    expect(sample.filter((row) => row.lane !== "untagged").every((row) => row.dbQueries === 0)).toBe(true);
  });

  it("runs a background sweep pass in the background_sweep lane, not in the residue (OPE-9058)", async () => {
    vi.useFakeTimers();
    try {
      const seen: Array<ReturnType<typeof currentLane>> = [];
      // The timer is armed outside every lane, like a startup sweep.
      expect(currentLane()).toBeNull();
      const timer = backgroundInterval(async () => {
        seen.push(currentLane());
        await Promise.resolve();
        seen.push(currentLane());
        recordLaneDbQuery();
      }, 1_000);
      timer.unref?.();

      await vi.advanceTimersByTimeAsync(2_000);
      clearInterval(timer);

      expect(seen).toEqual(["background_sweep", "background_sweep", "background_sweep", "background_sweep"]);
      expect(laneRow("background_sweep").dbQueries).toBe(2);
      expect(laneRow("background_sweep").executions).toBe(2);
      expect(laneRow("untagged").dbQueries).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets the early request tag attribute the middleware ahead of the api router to http_route (OPE-9058)", async () => {
    const { boardRequestLaneTagMiddleware } = await import("./request-load.js");
    const tag = boardRequestLaneTagMiddleware();
    let during: ReturnType<typeof currentLane> = null;
    await new Promise<void>((resolve) => {
      tag({} as never, {} as never, () => {
        // like actorMiddleware: a DB lookup behind an await, then next()
        void Promise.resolve().then(() => {
          during = currentLane();
          recordLaneDbQuery();
          resolve();
        });
      });
    });
    expect(during).toBe("http_route");
    expect(laneRow("http_route").dbQueries).toBe(1);
    // it tags only: the journal and the execution count stay with the api router
    expect(laneRow("http_route").executions).toBe(0);
    expect(laneRow("untagged").dbQueries).toBe(0);
  });
});
