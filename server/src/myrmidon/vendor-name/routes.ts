// GET/PATCH /api/myrmidon/vendor-name-check (myrmidon 1.7 REBRAND-F).
//
// GET reports the gate setting in force and where each value came from (the
// stored settings, an environment override, or the built-in default) together
// with the gate's own answer about this build — the visible and identifier
// counts of the built UI bundle and of the recorded response snapshots. Any
// authenticated board member may read it. PATCH writes
// `instance_settings.general.vendorNameCheck`; it is instance-admin only, the
// same rule the rest of the instance settings follow.

import { Router } from "express";
import type { Db } from "@myrmidon/db";
import { patchVendorNameCheckSchema, type VendorNameCheckPatch } from "@myrmidon/shared";
import { validate } from "../../middleware/validate.js";
import { assertBoardOrgAccess, assertInstanceAdmin, getActorInfo } from "../../routes/authz.js";
import type { VendorNameCheckService } from "./service.js";

export function vendorNameCheckRoutes(_db: Db, service: VendorNameCheckService) {
  const router = Router();

  router.get("/myrmidon/vendor-name-check", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(await service.read());
  });

  router.patch("/myrmidon/vendor-name-check", validate(patchVendorNameCheckSchema), async (req, res) => {
    assertInstanceAdmin(req);
    res.json(await service.update(req.body as VendorNameCheckPatch, getActorInfo(req)));
  });

  return router;
}