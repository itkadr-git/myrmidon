// server/src/myrmidon/baseline/routes.ts
//
// myrmidon(1.6-BASELINE): the read API.
//
//   GET /api/myrmidon/companies/:companyId/baseline/metrics?from&to
//   GET /api/myrmidon/companies/:companyId/baseline/compare?from&to
//   POST /api/myrmidon/companies/:companyId/baseline/snapshots {from, to, label, pinned}
//   GET /api/myrmidon/companies/:companyId/baseline/snapshots
//   GET /api/myrmidon/companies/:companyId/baseline/snapshots/:id
//

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
import { baselineMetricSnapshots } from "@paperclipai/db";
import { eq, and } from "drizzle-orm";
import { assertBoard } from "../../routes/authz.js";
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

  // Original metrics endpoint
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

  // Create a new baseline snapshot
  router.post("/myrmidon/companies/:companyId/baseline/snapshots", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req); // Only board/admin can create snapshots
    assertCompanyAccess(req, companyId);

    const { from, to, label, pinned } = req.body as {
      from: string;
      to: string;
      label?: string;
      pinned?: boolean;
    };

    // Validate required fields
    if (!from || !to) {
      return res.status(400).json({ error: "Both 'from' and 'to' are required" });
    }

    // Parse the window
    const window: BaselineWindow = {
      from: new Date(from),
      to: new Date(to)
    };

    // Compute the metrics for the given window
    const metrics = await compute(db, companyId, window, deps.now());

    // If pinned is true, unpin any existing pinned snapshot for this company
    if (pinned) {
      await db
        .update(baselineMetricSnapshots)
        .set({ pinned: false })
        .where(and(
          eq(baselineMetricSnapshots.companyId, companyId),
          eq(baselineMetricSnapshots.pinned, true)
        ));
    }

    // Insert the new snapshot. The row is typed from the table itself, so a
    // schema/route drift fails the typecheck instead of the insert.
    const snapshotRow: typeof baselineMetricSnapshots.$inferInsert = {
      companyId,
      windowFrom: window.from,
      windowTo: window.to,
      generatedAt: deps.now(),
      // The metrics answer is an interface, so it has no implicit index
      // signature; spread it into a plain record for the jsonb column.
      payload: { ...metrics },
      label,
      pinned: pinned || false
    };
    const [snapshot] = await db
      .insert(baselineMetricSnapshots)
      .values(snapshotRow)
      .returning();

    res.status(201).json(snapshot);
  });

  // Get all snapshots for a company
  router.get("/myrmidon/companies/:companyId/baseline/snapshots", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const snapshots = await db
      .select()
      .from(baselineMetricSnapshots)
      .where(eq(baselineMetricSnapshots.companyId, companyId));

    res.json(snapshots);
  });

  // Get a specific snapshot by ID
  router.get("/myrmidon/companies/:companyId/baseline/snapshots/:snapshotId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const snapshotId = req.params.snapshotId as string;
    assertCompanyAccess(req, companyId);

    const snapshot = await db
      .select()
      .from(baselineMetricSnapshots)
      .where(and(
        eq(baselineMetricSnapshots.id, snapshotId),
        eq(baselineMetricSnapshots.companyId, companyId)
      ))
      .limit(1);

    if (snapshot.length === 0) {
      return res.status(404).json({ error: "Snapshot not found" });
    }

    res.json(snapshot[0]);
  });

  return router;
}

/** The real wiring. */
export function myrmidonBaselineRoutes(db: Db) {
  return baselineRoutes(db, { now: () => new Date() });
}