import { Router } from "express";
import type { Db } from "@myrmidon/db";
import { issueAcceptanceSnapshotService } from "../services/issue-acceptance-snapshot.js";
import { assertAuthenticated, assertBoard, hasCompanyAccess } from "./authz.js";

/**
 * myrmidon(OPE-15134): the atomic acceptance snapshot the acceptance-reader
 * gateway reads upstream. One response carries the minimal issue identity
 * and its acceptance document from a single SQL statement (one MVCC
 * snapshot), so a CI gate never stitches an issue from one moment to a
 * document revision from another. Board actors only; cross-tenant and
 * missing issues are the identical 404 (no existence oracle); the response
 * carries minimal fields only and no rich issue relations.
 */
export function issueAcceptanceSnapshotRoutes(db: Db) {
  const router = Router();
  const snapshots = issueAcceptanceSnapshotService(db);

  router.get("/issues/:id/acceptance-scenarios-snapshot", async (req, res) => {
    // 401 for anonymous, 403 for non-board actors, both before any resource
    // access: the route stays free of any existence oracle.
    assertAuthenticated(req);
    assertBoard(req);
    const id = String(req.params.id ?? "").trim();
    // One statement resolves the issue (canonical identifier or UUID) and
    // reads the tenant-bound document graph; the access check then runs on
    // the very row that would be served, so an issue moved between companies
    // is never served to the previous tenant's actor (OPE-15145), and the
    // response can never mix two read moments.
    const snapshot = await snapshots.read(id);
    if (!snapshot || !hasCompanyAccess(req, snapshot.issue.companyId)) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    res.json(snapshot);
  });

  return router;
}
