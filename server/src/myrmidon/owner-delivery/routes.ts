// server/src/myrmidon/owner-delivery/routes.ts
//
// myrmidon(1.6.5-OWNER-DM-FILTER): the owner-DM delivery filter settings API.
//
// - GET /api/myrmidon/owner-delivery — the settings object `{ mode }`; any
//   authenticated board member may read it (part B renders the toggle from it).
// - PATCH /api/myrmidon/owner-delivery — write the mode; instance admin only,
//   the same rule the other instance settings follow.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { ownerDeliverySettingsSchema } from "@paperclipai/shared";
import { validate } from "../../middleware/validate.js";
import { assertBoardOrgAccess, assertInstanceAdmin } from "../../routes/authz.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import {
  readOwnerDeliverySettings,
  writeOwnerDeliverySettings,
} from "./settings.js";

export function ownerDeliveryRoutes(db: Db) {
  const router = Router();
  const settings = instanceSettingsService(db);

  router.get("/myrmidon/owner-delivery", async (_req, res) => {
    assertBoardOrgAccess(_req);
    res.json(await readOwnerDeliverySettings(settings));
  });

  router.patch(
    "/myrmidon/owner-delivery",
    validate(ownerDeliverySettingsSchema),
    async (req, res) => {
      assertInstanceAdmin(req);
      res.json(await writeOwnerDeliverySettings(settings, req.body));
    },
  );

  return router;
}
