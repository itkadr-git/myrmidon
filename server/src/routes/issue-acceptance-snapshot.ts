import { Router } from "express";
import type { Db } from "@myrmidon/db";
import { issueAcceptanceSnapshotService } from "../services/issue-acceptance-snapshot.js";
import { issueService } from "../services/issues.js";
import { assertAuthenticated, assertBoard, getAccessibleResource } from "./authz.js";

/**
 * myrmidon(OPE-15134): the atomic acceptance snapshot the acceptance-reader
 * gateway reads upstream. One response carries the minimal issue identity and
 * its acceptance document from a single SQL statement (one MVCC snapshot), so
 * a CI gate never stitches an issue from one moment to a document revision
 * from another. Board actors only; cross-tenant and missing issues are the
 * same 404 (no existence oracle); the response carries minimal fields only
 * and no rich issue relations.
 */
export function issueAcceptanceSnapshotRoutes(db: Db) {
  const router = Router();
  const svc = issueService(db);
  const snapshots = issueAcceptanceSnapshotService(db);

  router.get("/issues/:id/acceptance-scenarios-snapshot", async (req, res) => {
    // 401 for anonymous, 403 for non-board actors, both before any resource
    // access: the route stays free of any existence oracle.
    assertAuthenticated(req);
    assertBoard(req);
    const id = String(req.params.id ?? "").trim();
    const issue = await getAccessibleResource(
      req,
      res,
      svc.getById(id),
      "Issue not found",
    );
    if (!issue) return;
    const snapshot = await snapshots.read(issue.id);
    if (!snapshot) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    res.json(snapshot);
  });

  return router;
}
