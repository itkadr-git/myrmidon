// server/src/myrmidon/data-retention/routes.ts
//
// myrmidon(1.6.5-DB-RETENTION): GET/PATCH /api/myrmidon/data-retention.
//
// GET reports the retention settings with their per-key source
// ("settings" | "default") and the persisted state of the last sweep pass.
// Any authenticated board member may read it. PATCH writes
// `instance_settings.general.datastoreCare.retention` and is instance-admin only, the
// same rule the rest of the instance settings follow; the sweep re-reads the
// settings at the top of every pass, so the change applies without a restart.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  patchDataRetentionSettingsSchema,
  type DataRetentionSettingsPatch,
} from "@paperclipai/shared";
import { validate } from "../../middleware/validate.js";
import { assertBoardOrgAccess, assertInstanceAdmin, getActorInfo } from "../../routes/authz.js";
import type { DataRetentionService } from "./service.js";

export function dataRetentionRoutes(_db: Db, service: DataRetentionService) {
  const router = Router();

  router.get("/myrmidon/data-retention", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(await service.read());
  });

  router.patch(
    "/myrmidon/data-retention",
    validate(patchDataRetentionSettingsSchema),
    async (req, res) => {
      assertInstanceAdmin(req);
      res.json(
        await service.update(req.body as DataRetentionSettingsPatch, getActorInfo(req)),
      );
    },
  );

  return router;
}
