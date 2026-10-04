// server/src/myrmidon/baseline/routes.ts
//
// myrmidon(1.6-BASELINE): the read API.
//
//   GET /api/myrmidon/companies/:companyId/baseline/metrics?from&to
//   GET /api/myrmidon/companies/:companyId/baseline/compare?from&to
//
// Company access is the same check the vendor costs routes and the gateway
// costs routes use. `from` and `to` are required ISO timestamps.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assertCompanyAccess } from "../../routes/authz.js";
import { 
  computeBaselineMetrics, 
  parseBaselineWindow, 
  type BaselineMetricsResponse,
  getLatestBaselineSnapshot,
  compareWithBaseline,
  type BaselineComparisonResult
} from "./service.js";
import type { BaselineWindow } from "./metrics.js";

export interface BaselineRoutesDeps {
  now(): Date;
  /** Overridable in tests; the real wiring uses computeBaselineMetrics. */
  compute?(db: Db, companyId: string, window: BaselineWindow, now: Date): Promise<BaselineMetricsResponse>;
  /** Overridable in tests; the real wiring uses getLatestBaselineSnapshot. */
  getBaselineSnapshot?(db: Db, companyId: string): Promise<BaselineMetricsResponse | null>;
}

export function baselineRoutes(db: Db, deps: BaselineRoutesDeps) {
  const router = Router();
  const compute = deps.compute ?? computeBaselineMetrics;
  const getBaselineSnapshot = deps.getBaselineSnapshot ?? getLatestBaselineSnapshot;

  router.get("/myrmidon/companies/:companyId/baseline/metrics", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const window = parseBaselineWindow(req.query as Record<string, unknown>);
    const metrics = await compute(db, companyId, window, deps.now());
    res.json(metrics);
  });

  router.get("/myrmidon/companies/:companyId/baseline/compare", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const window = parseBaselineWindow(req.query as Record<string, unknown>);
    
    // Get current metrics for the specified window
    const currentMetrics = await compute(db, companyId, window, deps.now());
    
    // Get the latest baseline snapshot
    const baselineSnapshot = await getBaselineSnapshot(db, companyId);
    
    // Compare current metrics with baseline
    const comparison = compareWithBaseline(currentMetrics, baselineSnapshot);
    
    res.json(comparison);
  });

  return router;
}

/** The real wiring. */
export function myrmidonBaselineRoutes(db: Db) {
  return baselineRoutes(db, { now: () => new Date() });
}