// server/src/myrmidon/datastore-care/retention/routes.ts
//
// myrmidon(1.6.5-DBC1): GET/PATCH /api/myrmidon/datastore-care.
//
// GET reports the resolved retention settings with their source
// ("settings" | "env" | "default") and the persisted state of the last
// compaction pass. Any authenticated board member may read it. PATCH writes
// `instance_settings.general.datastoreCare.retention` and is instance-admin
// only, the same rule the rest of the instance settings follow; the sweep
// re-reads the settings at the top of every pass, so the change applies
// without a restart.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  patchDatastoreCareRetentionSchema,
  type DatastoreCareRetentionPatch,
} from "@paperclipai/shared";
import { validate } from "../../../middleware/validate.js";
import { assertBoardOrgAccess, assertInstanceAdmin } from "../../../routes/authz.js";
import { instanceSettingsService } from "../../../services/instance-settings.js";
import {
  readRetentionLastRun,
  readRetentionSettings,
  writeRetentionSettings,
} from "./settings.js";

export function datastoreCareRoutes(db: Db) {
  const router = Router();
  const settings = instanceSettingsService(db);

  router.get("/myrmidon/datastore-care", async (req, res) => {
    assertBoardOrgAccess(req);
    const resolved = await readRetentionSettings(settings);
    const lastRun = await readRetentionLastRun(settings);
    res.json({
      retention: {
        heartbeatRunContextDays: resolved.heartbeatRunContextDays,
        source: resolved.source,
      },
      lastRun,
    });
  });

  router.patch(
    "/myrmidon/datastore-care",
    validate(patchDatastoreCareRetentionSchema),
    async (req, res) => {
      assertInstanceAdmin(req);
      res.json(await writeRetentionSettings(settings, req.body as DatastoreCareRetentionPatch));
    },
  );

  return router;
}
