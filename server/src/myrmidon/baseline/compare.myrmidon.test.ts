// myrmidon(1.6.2-BASELINE-C): the compare endpoint contract. Differences are
// per key of byProject/byRole — never a weighted blend over the two pools
// (every task would be counted twice) — and every expected number below is
// pinned, so the double-count, the hard-coded reviewTimeP90 and the
// zero-baseline-as-0% behaviours fail loudly if they come back.

import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { compareWithBaseline } from "./service.js";
import type { BaselineMetricsResponse } from "./service.js";
import type { BaselineGroupMetrics } from "./metrics.js";
import { baselineRoutes } from "./routes.js";
import type { Db } from "@paperclipai/db";

const WINDOW = { from: "2026-09-01T00:00:00.000Z", to: "2026-09-15T00:00:00.000Z" };
const SOURCE = { statusLog: "activity_log", costs: "litellm_cost_events" as const };

function group(key: string | null, over: Partial<BaselineGroupMetrics> = {}): BaselineGroupMetrics {
  return {
    key,
    tasksCompleted: 20,
    cycleTimeHours: { mean: 100, median: 95, p90: 120 },
    timeInReviewHours: { mean: 20, median: 18 },
    returnRate: { enteredReview: 100, returned: 15, rate: 0.15 },
    blockedHours: { total: 10, mean: 2, topCauses: [] },
    runsPerTask: { total: 60, mean: 3 },
    costPerTask: { totalCents: 50000, meanCents: 2500 },
    ...over,
  };
}

function report(
  byProject: BaselineGroupMetrics[],
  byRole: BaselineGroupMetrics[],
  generatedAt = "2026-09-15T00:00:00.000Z",
): BaselineMetricsResponse {
  return { window: WINDOW, generatedAt, source: SOURCE, byProject, byRole };
}

describe("myrmidon(1.6.2-BASELINE-C) compareWithBaseline", () => {
  it("computes per-key differences with exact numbers, one count per task", () => {
    // The same 20 tasks appear under project "p1" and role "engineer".
    // The old aggregateMetrics pooled byProject+byRole and reported
    // tasksCompleted = 40; per-key diffing must report 20.
    const current = report(
      [group("p1"), group("p2", { tasksCompleted: 5 })],
      [group("engineer")],
    );
    const baseline = report(
      [group("p1", { tasksCompleted: 10, cycleTimeHours: { mean: 80, median: 70, p90: 100 } })],
      [group("engineer", { tasksCompleted: 10, costPerTask: { totalCents: 20000, meanCents: 2000 } })],
      "2026-09-01T00:00:00.000Z",
    );

    const result = compareWithBaseline(current, baseline);

    expect(result.current).toEqual(current);
    expect(result.baseline).toEqual(baseline);
    expect(result.differences).not.toBeNull();

    const p1 = result.differences!.byProject["p1"]!;
    expect(p1.tasksCompleted).toEqual({ absolute: 10, percentage: 100 });
    expect(p1.cycleTimeMean).toEqual({ absolute: 20, percentage: 25 });
    expect(p1.cycleTimeMedian).toEqual({ absolute: 25, percentage: expect.closeTo(35.714, 3) });
    expect(p1.cycleTimeP90).toEqual({ absolute: 20, percentage: 20 });
    expect(p1.reviewTimeMean).toEqual({ absolute: 0, percentage: 0 });
    expect(p1.returnRate).toEqual({ absolute: 0, percentage: 0 });
    expect(p1.blockedTotal).toEqual({ absolute: 0, percentage: 0 });
    expect(p1.runsPerTask).toEqual({ absolute: 0, percentage: 0 });
    expect(p1.costPerTask).toEqual({ absolute: 0, percentage: 0 });

    const engineer = result.differences!.byRole["engineer"]!;
    expect(engineer.tasksCompleted).toEqual({ absolute: 10, percentage: 100 });
    expect(engineer.costPerTask).toEqual({ absolute: 500, percentage: 25 });

    // p2 exists only on the current side: nothing to compare it against.
    expect(result.differences!.byProject["p2"]).toBeUndefined();
  });

  it("diffs a null project key under the '' record key", () => {
    const current = report([group(null)], []);
    const baseline = report([group(null, { tasksCompleted: 4 })], []);
    const result = compareWithBaseline(current, baseline);
    expect(result.differences!.byProject[""]!.tasksCompleted).toEqual({ absolute: 16, percentage: 400 });
  });

  it("keeps the absolute change and reports percentage null when the baseline value is 0", () => {
    // Return rate 0 -> 0.15 is a real regression; the old code reported 0%.
    const current = report([group("p1")], []);
    const baseline = report([
      group("p1", {
        returnRate: { enteredReview: 10, returned: 0, rate: 0 },
        blockedHours: { total: 0, mean: 0, topCauses: [] },
      }),
    ], [], "2026-09-01T00:00:00.000Z");
    const result = compareWithBaseline(current, baseline);
    const p1 = result.differences!.byProject["p1"]!;
    expect(p1.returnRate).toEqual({ absolute: 0.15, percentage: null });
    expect(p1.blockedTotal).toEqual({ absolute: 10, percentage: null });
  });

  it("has no reviewTimeP90 difference — the contract has no p90 for review time", () => {
    const current = report([group("p1")], []);
    const baseline = report([group("p1")], []);
    const result = compareWithBaseline(current, baseline);
    const p1 = result.differences!.byProject["p1"]!;
    expect("reviewTimeP90" in p1).toBe(false);
    expect(p1).not.toHaveProperty("reviewTimeP90");
  });

  it("handles an empty window (no groups on either side)", () => {
    const result = compareWithBaseline(report([], []), report([], []));
    expect(result.differences).toEqual({ byProject: {}, byRole: {} });
  });

  it("returns differences: null when there is no baseline snapshot", () => {
    const result = compareWithBaseline(report([group("p1")], []), null);
    expect(result.current.byProject).toHaveLength(1);
    expect(result.baseline).toBeNull();
    expect(result.differences).toBeNull();
  });
});

describe("myrmidon(1.6.2-BASELINE-C) compare route", () => {
  const COMPANY = "11111111-1111-4111-8111-111111111111";
  const board = { type: "board", source: "session", userId: "user-a", isInstanceAdmin: true, companyIds: [COMPANY] };

  function app(getBaselineSnapshot: (db: Db, companyId: string) => Promise<BaselineMetricsResponse | null>) {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = board;
      next();
    });
    server.use(
      "/api",
      baselineRoutes({} as Db, {
        now: () => new Date("2026-09-15T00:00:00Z"),
        compute: async () => report([group("p1")], [group("engineer")]),
        getBaselineSnapshot,
      }),
    );
    return server;
  }

  it("answers per-key differences using the overridden snapshot dep", async () => {
    const snapshot = report(
      [group("p1", { tasksCompleted: 10 })],
      [group("engineer", { tasksCompleted: 10 })],
      "2026-09-01T00:00:00.000Z",
    );
    let snapshotCompany: string | null = null;
    const server = app(async (_db, companyId) => {
      snapshotCompany = companyId;
      return snapshot;
    });

    const response = await request(server)
      .get(`/api/myrmidon/companies/${COMPANY}/baseline/compare`)
      .query({ from: "2026-09-01T00:00:00Z", to: "2026-09-15T00:00:00Z" });

    expect(response.status).toBe(200);
    expect(snapshotCompany).toBe(COMPANY);
    expect(response.body.differences.byProject.p1.tasksCompleted).toEqual({ absolute: 10, percentage: 100 });
    expect(response.body.differences.byRole.engineer.tasksCompleted).toEqual({ absolute: 10, percentage: 100 });
    expect(response.body.differences.byProject.p1.reviewTimeP90).toBeUndefined();
  });

  it("answers differences: null when no snapshot exists", async () => {
    const server = app(async () => null);
    const response = await request(server)
      .get(`/api/myrmidon/companies/${COMPANY}/baseline/compare`)
      .query({ from: "2026-09-01T00:00:00Z", to: "2026-09-15T00:00:00Z" });
    expect(response.status).toBe(200);
    expect(response.body.baseline).toBeNull();
    expect(response.body.differences).toBeNull();
  });
});
