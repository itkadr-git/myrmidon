// server/src/myrmidon/monitoring/board-load/request-load.ts
//
// myrmidon(1.6.6 PROCS-0.3A): the API load journal of design OPE-5394 §1 П3.
//
// "How loaded is the API" used to be answerable only by an operator running a
// script against the board (or against the reverse proxy's log). This module
// keeps the same answer in the process: one bounded ring of finished HTTP
// requests, and a per-route percentile summary over a window.
//
// Deliberately nothing else: no aggregation timer, no store, no migration and
// no per-route time series. The ring holds the last `capacity` requests (2 000
// by default — a few hundred kilobytes at worst, whatever the traffic), and the
// summary is computed on read, so the journal costs one object push per request
// and no CPU of its own.

import type { Request, RequestHandler } from "express";
import { enterLane, recordLaneExecution, type BoardLane } from "./lanes.js";

/** Requests kept before the ring overwrites its oldest entry. */
export const DEFAULT_REQUEST_LOG_CAPACITY = 2000;
/** Window the summary reports over unless the caller asks for another one. */
export const DEFAULT_REQUEST_LOAD_WINDOW_SEC = 900;
/** Routes reported by the summary unless the caller asks for more. */
export const DEFAULT_REQUEST_LOAD_ROUTES = 50;
const MAX_ROUTE_LABEL_LENGTH = 120;
const MAX_ROUTE_SEGMENTS = 8;

export interface RequestLoadRecord {
  method: string;
  /** Normalized route label — see {@link normalizePath}. */
  route: string;
  status: number;
  durationMs: number;
  /** Start of the request, epoch milliseconds. */
  at: number;
}

export interface RequestLoadRouteSample {
  method: string;
  route: string;
  count: number;
  /** Answers with status >= 500. */
  errorCount: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface RequestLoadReadInput {
  windowMs: number;
  /** Epoch milliseconds the window ends at (normally "now"). */
  now: number;
  limit?: number;
}

export interface RequestLog {
  record(record: RequestLoadRecord): void;
  read(input: RequestLoadReadInput): RequestLoadRouteSample[];
  /** Requests currently held by the ring. */
  size(): number;
}

/**
 * Nearest-rank percentile of an ascending list, in milliseconds.
 *
 * Nearest-rank (not interpolation) on purpose: with a few hundred samples per
 * route an interpolated p95 invents a value no request ever measured, and the
 * point of this number is to name a real request the board served.
 */
export function percentileMs(ascending: number[], quantile: number): number {
  if (ascending.length === 0) return 0;
  const clamped = Math.min(1, Math.max(0, quantile));
  const rank = Math.ceil(clamped * ascending.length);
  const index = Math.min(ascending.length - 1, Math.max(0, rank - 1));
  return ascending[index] ?? 0;
}

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_ID_SEGMENT = /^[0-9a-f]{16,}$/i;
const NUMERIC_SEGMENT = /^\d+$/;
const OPAQUE_SEGMENT = /^[A-Za-z0-9_-]{20,}$/;

/**
 * Replaces the identifying segments of a path with `:id`.
 *
 * The point is cardinality: `/api/issues/8f1c…/comments` and
 * `/api/issues/0048…/comments` are one route with one latency distribution,
 * not two. Anything that looks like an id — a UUID, a long hex run, a plain
 * number, a long opaque token — becomes `:id`; everything else (real words)
 * is kept, so the label still says which endpoint it was.
 */
export function normalizePath(path: string): string {
  const withoutQuery = path.split("?")[0] ?? "/";
  const segments = withoutQuery.split("/").filter((segment) => segment.length > 0);
  const normalized = segments.slice(0, MAX_ROUTE_SEGMENTS).map((segment) => {
    if (UUID_SEGMENT.test(segment) || NUMERIC_SEGMENT.test(segment)) return ":id";
    if (HEX_ID_SEGMENT.test(segment) || OPAQUE_SEGMENT.test(segment)) return ":id";
    return segment;
  });
  if (segments.length > MAX_ROUTE_SEGMENTS) normalized.push(":rest");
  const joined = `/${normalized.join("/")}`;
  return joined.length > MAX_ROUTE_LABEL_LENGTH ? joined.slice(0, MAX_ROUTE_LABEL_LENGTH) : joined;
}

/**
 * The route label of a finished request.
 *
 * A request express matched carries the pattern it matched (`req.route.path`,
 * prefixed with the router's base) — exactly the label the summary should
 * report. A request that matched nothing (404, an error before routing) has no
 * pattern at all, so its path is normalized instead and still grouped.
 */
export function requestRouteOf(req: Request): string {
  const matched = (req as Request & { route?: { path?: unknown } }).route?.path;
  if (typeof matched === "string" && matched.length > 0) {
    const base = typeof req.baseUrl === "string" ? req.baseUrl : "";
    const label = `${base}${matched}`;
    return label.length > MAX_ROUTE_LABEL_LENGTH ? label.slice(0, MAX_ROUTE_LABEL_LENGTH) : label;
  }
  return normalizePath(req.originalUrl ?? req.url ?? "/");
}

/** Bounded ring of finished requests. */
export function createRequestLog(options: { capacity?: number } = {}): RequestLog {
  const capacity = Math.max(1, Math.floor(options.capacity ?? DEFAULT_REQUEST_LOG_CAPACITY));
  const ring: Array<RequestLoadRecord | null> = new Array<RequestLoadRecord | null>(capacity).fill(null);
  let cursor = 0;
  let stored = 0;

  return {
    record(record) {
      ring[cursor] = record;
      cursor = (cursor + 1) % capacity;
      if (stored < capacity) stored += 1;
    },
    size() {
      return stored;
    },
    read(input) {
      const since = input.now - Math.max(0, input.windowMs);
      const byRoute = new Map<string, { method: string; route: string; durations: number[]; errorCount: number }>();
      for (const entry of ring) {
        if (!entry || entry.at < since) continue;
        const key = `${entry.method} ${entry.route}`;
        let bucket = byRoute.get(key);
        if (!bucket) {
          bucket = { method: entry.method, route: entry.route, durations: [], errorCount: 0 };
          byRoute.set(key, bucket);
        }
        bucket.durations.push(entry.durationMs);
        if (entry.status >= 500) bucket.errorCount += 1;
      }

      const samples: RequestLoadRouteSample[] = [];
      for (const bucket of byRoute.values()) {
        const sorted = [...bucket.durations].sort((a, b) => a - b);
        samples.push({
          method: bucket.method,
          route: bucket.route,
          count: sorted.length,
          errorCount: bucket.errorCount,
          p50Ms: percentileMs(sorted, 0.5),
          p95Ms: percentileMs(sorted, 0.95),
          p99Ms: percentileMs(sorted, 0.99),
          maxMs: sorted[sorted.length - 1] ?? 0,
        });
      }
      samples.sort((a, b) => (b.p95Ms - a.p95Ms) || (b.count - a.count) || a.route.localeCompare(b.route));
      return samples.slice(0, Math.max(1, Math.floor(input.limit ?? DEFAULT_REQUEST_LOAD_ROUTES)));
    },
  };
}

/**
 * Tags every request with the `http_route` lane, journals it when it finishes,
 * and hands the request on untouched.
 *
 * Mounted on the api router before the routes, so everything the board serves
 * under `/api` is attributed and journaled — including a request that ends in
 * an error handler, because it is `finish` (the response ends) that records it,
 * not a successful route match. The middleware never short-circuits, rewrites
 * or delays the response; if the journal is full the oldest entry is simply
 * overwritten.
 */
export function boardRequestLoadMiddleware(
  log: RequestLog,
  options: { now?: () => number; lane?: BoardLane } = {},
): RequestHandler {
  const lane: BoardLane = options.lane ?? "http_route";
  const now = options.now ?? (() => Date.now());
  return (req, res, next) => {
    const started = performance.now();
    const startedAt = now();
    res.on("finish", () => {
      const durationMs = performance.now() - started;
      log.record({
        method: req.method,
        route: requestRouteOf(req),
        status: res.statusCode,
        durationMs,
        at: startedAt,
      });
      recordLaneExecution(lane, durationMs);
    });
    enterLane(lane, () => {
      next();
    });
  };
}