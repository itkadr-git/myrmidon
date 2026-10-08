// server/src/myrmidon/datastore-care/routes.ts
//
// myrmidon(DBC-4): HTTP surface of datastore care.
//
//   GET  /api/myrmidon/datastores                       — targets + live sizes
//   GET  /api/myrmidon/datastores/:key/snapshots        — collected history
//   POST /api/myrmidon/datastores/:key/snapshots        — collect now
//   GET  /api/myrmidon/datastores/:key/audit-reports    — generated reports
//   POST /api/myrmidon/datastores/:key/audit-reports    — the audit button
//   GET  /api/myrmidon/audit-reports/:reportId          — one report (JSON)
//   GET  /api/myrmidon/audit-reports/:reportId/export   — the .md export
//
// Every route is a board read: the module measures the board's database, it
// never writes to it, and it has no rules and no actions to authorise. That is
// why the whole surface is board-org access rather than instance-admin — the
// operator who presses the audit button in the board UI must be able to read
// what it produced.
//
// The kill switch (`MYRMIDON_DATASTORE_CARE_ENABLED=0`) follows the house rule
// of myrmidon flags: reads stay readable and report `enabled: false`, writes
// refuse with 409. The flag is on by default — it exists so an operator can
// stop the hourly collection on a loaded instance, not as a rollout gate.

import { Router, type Response } from "express";

import { assertBoardOrgAccess } from "../../routes/authz.js";
import { isDatastoreCareEnabled } from "./settings.js";
import { UnknownDatastoreError, type DatastoreCareService } from "./service.js";

export interface DatastoreCareRoutesOptions {
  service: DatastoreCareService;
  /** Environment read for the kill switch; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

function parseLimit(raw: unknown): number | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function datastoreCareRoutes(options: DatastoreCareRoutesOptions) {
  const { service } = options;
  const env = options.env ?? process.env;
  const router = Router();

  /** Answers 404 for an unknown target and reports whether it did. */
  const handleUnknown = (error: unknown, res: Response): boolean => {
    if (error instanceof UnknownDatastoreError) {
      res.status(404).json({ error: "unknown_datastore", message: error.message });
      return true;
    }
    return false;
  };

  /** Writes refuse while the module is switched off; reads report the state. */
  const refuseDisabled = (res: Response): void => {
    res.status(409).json({
      error: "datastore_care_disabled",
      message: "datastore care is disabled (MYRMIDON_DATASTORE_CARE_ENABLED=0)",
    });
  };

  router.get("/myrmidon/datastores", async (req, res) => {
    assertBoardOrgAccess(req);
    if (!isDatastoreCareEnabled(env)) {
      res.json({ enabled: false, targets: [], settings: null });
      return;
    }
    res.json(await service.readTargets());
  });

  router.get("/myrmidon/datastores/:key/snapshots", async (req, res) => {
    assertBoardOrgAccess(req);
    if (!isDatastoreCareEnabled(env)) {
      res.json({ enabled: false, snapshots: [] });
      return;
    }
    try {
      const snapshots = await service.listSnapshots(req.params.key, parseLimit(req.query.limit));
      res.json({ snapshots });
    } catch (error) {
      if (!handleUnknown(error, res)) throw error;
    }
  });

  router.post("/myrmidon/datastores/:key/snapshots", async (req, res) => {
    assertBoardOrgAccess(req);
    if (!isDatastoreCareEnabled(env)) {
      refuseDisabled(res);
      return;
    }
    try {
      const { snapshot, target } = await service.captureSnapshot(req.params.key);
      res.json({ target: { key: target.key, engine: target.engine }, snapshot });
    } catch (error) {
      if (!handleUnknown(error, res)) throw error;
    }
  });

  router.get("/myrmidon/datastores/:key/audit-reports", async (req, res) => {
    assertBoardOrgAccess(req);
    if (!isDatastoreCareEnabled(env)) {
      res.json({ enabled: false, reports: [] });
      return;
    }
    try {
      const reports = await service.listAuditReports(req.params.key, parseLimit(req.query.limit));
      // The list carries the markdown too; the UI and scripts fetch the export
      // route when they want the file, so drop it from the list answer.
      res.json({ reports: reports.map(({ markdown: _markdown, ...rest }) => rest) });
    } catch (error) {
      if (!handleUnknown(error, res)) throw error;
    }
  });

  router.post("/myrmidon/datastores/:key/audit-reports", async (req, res) => {
    assertBoardOrgAccess(req);
    if (!isDatastoreCareEnabled(env)) {
      refuseDisabled(res);
      return;
    }
    try {
      const result = await service.createAuditReport(req.params.key, "manual");
      const { markdown: _markdown, ...report } = result.report;
      res.json({
        report,
        summary: result.summary,
        snapshotId: result.snapshotId,
        exportUrl: `/api/myrmidon/audit-reports/${result.report.id}/export`,
      });
    } catch (error) {
      if (!handleUnknown(error, res)) throw error;
    }
  });

  router.get("/myrmidon/audit-reports/:reportId", async (req, res) => {
    assertBoardOrgAccess(req);
    if (!isDatastoreCareEnabled(env)) {
      refuseDisabled(res);
      return;
    }
    const report = await service.readAuditReport(req.params.reportId);
    if (!report) {
      res.status(404).json({ error: "unknown_audit_report", message: req.params.reportId });
      return;
    }
    res.json({ report });
  });

  router.get("/myrmidon/audit-reports/:reportId/export", async (req, res) => {
    assertBoardOrgAccess(req);
    if (!isDatastoreCareEnabled(env)) {
      refuseDisabled(res);
      return;
    }
    const exported = await service.exportAuditMarkdown(req.params.reportId);
    if (!exported) {
      res.status(404).json({ error: "unknown_audit_report", message: req.params.reportId });
      return;
    }
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${exported.filename}"`);
    res.send(exported.markdown);
  });

  return router;
}