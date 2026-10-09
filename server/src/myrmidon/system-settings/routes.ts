// myrmidon(1.7, OPE-4101, SETTINGS-TO-UI E): GET /api/myrmidon/system/deployment
// — the read-only "Deployment" status block of the System settings tab.
// Board and agent actors may read it; anonymous callers get 403 (same rule as
// the about surface). The response lists which infrastructure integrations
// are configured, never the values themselves.

import { Router } from "express";
import { assertBoardOrAgent } from "../../routes/authz.js";
import { readDeploymentStatus } from "./deployment-status.js";

export function systemDeploymentRoutes(): Router {
  const router = Router();
  router.get("/myrmidon/system/deployment", (_req, res) => {
    assertBoardOrAgent(_req);
    res.json({ rows: readDeploymentStatus() });
  });
  return router;
}
