// myrmidon(1.6.6 PROCS-0.3A): the API load journal of design OPE-5394 §1 П3.
//
// What these tests pin: the journal is a bounded ring (a long-running board
// must not grow), a read is a window over that ring (so "p95 over the last
// 15 minutes" is answerable without a metrics stack), the percentile is
// nearest-rank (a real request, not an invented value), route labels collapse
// ids (cardinality) but keep words (the label still names the endpoint), and
// the middleware both journals the request and tags it with the http_route
// lane while it runs.

import { beforeEach, describe, expect, it } from "vitest";
import type { Request, Response } from "express";
import {
  boardRequestLoadMiddleware,
  createRequestLog,
  normalizePath,
  percentileMs,
  requestRouteOf,
} from "./request-load.js";
import { readLaneSample, resetLaneCounters } from "./lanes.js";

describe("api load journal", () => {
  beforeEach(() => {
    resetLaneCounters();
  });

  it("computes the nearest-rank percentile of an ascending sample", () => {
    expect(percentileMs([], 0.95)).toBe(0);
    expect(percentileMs([10], 0.95)).toBe(10);
    expect(percentileMs([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentileMs([1, 2, 3, 4], 0.95)).toBe(4);
    expect(percentileMs([1, 2, 3, 4], 1)).toBe(4);
    expect(percentileMs([1, 2, 3, 4], -1)).toBe(1);
    const hundred = Array.from({ length: 100 }, (_unused, index) => index + 1);
    expect(percentileMs(hundred, 0.95)).toBe(95);
  });

  it("collapses identifying path segments and keeps words", () => {
    expect(normalizePath("/api/issues/8f1c9d2e-1234-4abc-8def-0123456789ab/comments")).toBe(
      "/api/issues/:id/comments",
    );
    expect(normalizePath("/api/runs/123/events?x=1")).toBe("/api/runs/:id/events");
    expect(normalizePath("/api/agents/abcdef0123456789abcdef0123456789")).toBe("/api/agents/:id");
    expect(normalizePath("/api/health")).toBe("/api/health");
    expect(normalizePath("/")).toBe("/");
    const deep = normalizePath("/a/b/c/d/e/f/g/h/i/j");
    expect(deep.endsWith("/:rest")).toBe(true);
  });

  it("labels a matched request by the pattern it matched", () => {
    const matched = {
      baseUrl: "/api",
      route: { path: "/issues/:id/comments" },
      originalUrl: "/api/issues/8f1c9d2e-1234-4abc-8def-0123456789ab/comments",
    } as unknown as Request;
    expect(requestRouteOf(matched)).toBe("/api/issues/:id/comments");

    const unmatched = {
      baseUrl: "",
      originalUrl: "/api/nope/8f1c9d2e-1234-4abc-8def-0123456789ab",
    } as unknown as Request;
    expect(requestRouteOf(unmatched)).toBe("/api/nope/:id");
  });

  it("keeps the ring bounded and reports only the requested window", () => {
    const log = createRequestLog({ capacity: 2 });
    log.record({ method: "GET", route: "/api/a", status: 200, durationMs: 5, at: 1_000 });
    log.record({ method: "GET", route: "/api/a", status: 500, durationMs: 25, at: 2_000 });
    log.record({ method: "GET", route: "/api/b", status: 200, durationMs: 9, at: 3_000 });

    expect(log.size()).toBe(2);

    const all = log.read({ windowMs: 10_000, now: 3_000 });
    const routeA = all.find((row) => row.route === "/api/a");
    const routeB = all.find((row) => row.route === "/api/b");
    expect(routeB?.count).toBe(1);
    // The first /api/a record was overwritten by the ring — capacity is a
    // property of the journal, not of the window.
    expect(routeA?.count).toBe(1);
    expect(routeA?.errorCount).toBe(1);
    expect(routeA?.p95Ms).toBe(25);
    expect(routeA?.maxMs).toBe(25);

    expect(log.read({ windowMs: 500, now: 3_000 }).map((row) => row.route)).toEqual(["/api/b"]);
    expect(log.read({ windowMs: 10_000, now: 3_000, limit: 1 })).toHaveLength(1);
  });

  it("groups one route across methods and sorts the busiest first", () => {
    const log = createRequestLog({ capacity: 100 });
    for (let index = 0; index < 20; index += 1) {
      log.record({ method: "GET", route: "/api/slow", status: 200, durationMs: 100 + index, at: 1_000 });
    }
    log.record({ method: "POST", route: "/api/slow", status: 200, durationMs: 5, at: 1_000 });
    log.record({ method: "GET", route: "/api/fast", status: 200, durationMs: 1, at: 1_000 });

    const rows = log.read({ windowMs: 10_000, now: 1_000 });
    expect(rows.map((row) => `${row.method} ${row.route}`)).toEqual(["GET /api/slow", "POST /api/slow", "GET /api/fast"]);
    expect(rows[0]?.count).toBe(20);
    // Nearest-rank: 20 samples of 100..119 ms → p50 is the 10th (109 ms), p95
    // the 19th (118 ms) — values the board actually served.
    expect(rows[0]?.p50Ms).toBe(109);
    expect(rows[0]?.p95Ms).toBe(118);
  });

  it("journals a finished request and tags it with the http_route lane", () => {
    const log = createRequestLog({ capacity: 10 });
    const middleware = boardRequestLoadMiddleware(log);
    let onFinish: (() => void) | null = null;

    const req = {
      method: "POST",
      baseUrl: "/api",
      route: { path: "/runs/:id/events" },
      originalUrl: "/api/runs/42/events",
    } as unknown as Request;
    const res = {
      statusCode: 503,
      on(event: string, listener: () => void) {
        if (event === "finish") onFinish = listener;
        return this;
      },
    } as unknown as Response;

    let reachedNext = false;
    middleware(req, res, () => {
      reachedNext = true;
    });
    // The lane is in force for the handler (enterLane — context, not a counted
    // pass); the request is counted once, when it finishes, with its own
    // duration — not when express hands it on.
    expect(readLaneSample().find((row) => row.lane === "http_route")?.executions).toBe(0);
    expect(typeof onFinish).toBe("function");

    (onFinish as unknown as () => void)();

    expect(reachedNext).toBe(true);
    const rows = log.read({ windowMs: 60_000, now: Date.now() });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.route).toBe("/runs/:id/events");
    expect(rows[0]?.count).toBe(1);
    expect(rows[0]?.errorCount).toBe(1);
    const lane = readLaneSample().find((row) => row.lane === "http_route");
    expect(lane?.executions).toBe(1);
  });
});