import { beforeEach, describe, expect, it } from "vitest";
import {
  clearFleetSiteGauges,
  readFleetSiteMetrics,
  recordFleetExecRetry,
  recordFleetMove,
  recordFleetSiteHealth,
  resetFleetSiteMetrics,
} from "./fleet-site-metrics.js";

beforeEach(() => resetFleetSiteMetrics());

describe("fleet site metrics registry", () => {
  it("renders every move result at zero before anything happened", () => {
    expect(readFleetSiteMetrics().movesTotal).toEqual([
      { result: "done", count: 0 },
      { result: "failed", count: 0 },
      { result: "unavailable", count: 0 },
    ]);
  });

  it("gauges follow the last probe and report the age of the last answer", () => {
    recordFleetSiteHealth("b", false, 1_000);
    recordFleetSiteHealth("a", true, 61_000);
    expect(readFleetSiteMetrics(91_000).sites).toEqual([
      { site: "a", reachable: 1, lastSeenSeconds: 30 },
      { site: "b", reachable: 0, lastSeenSeconds: 90 },
    ]);
    recordFleetSiteHealth("never", false, null);
    expect(readFleetSiteMetrics(91_000).sites.find((s) => s.site === "never")?.lastSeenSeconds).toBeNull();
    clearFleetSiteGauges();
    expect(readFleetSiteMetrics().sites).toEqual([]);
  });

  it("counts retries per site and moves per result", () => {
    recordFleetExecRetry("a");
    recordFleetExecRetry("a");
    recordFleetExecRetry("b");
    recordFleetMove("done");
    recordFleetMove("failed");
    recordFleetMove("done");
    const m = readFleetSiteMetrics();
    expect(m.retriesTotal).toEqual([{ site: "a", count: 2 }, { site: "b", count: 1 }]);
    expect(m.movesTotal.find((r) => r.result === "done")?.count).toBe(2);
  });
});
