// GET/PATCH /api/myrmidon/team-liveness (myrmidon TEAM-LIVENESS-SETTINGS).
//
// GET reports the effective knobs of the three automatic team-liveness
// behaviours, which keys the instance has saved, and — per key — whether the
// stored value, the environment or the built-in default is in force. PATCH
// writes `instance_settings.general.teamLiveness`; it is instance-admin only,
// the same rule the rest of the instance settings follow. No live apply step:
// the three sweeps read the row on every pass
// (`team-liveness/settings.ts`), so a change takes effect on the next pass.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  patchTeamLivenessSettingsSchema,
  type TeamLivenessSettingsPatch,
} from "@paperclipai/shared";
import { validate } from "../../middleware/validate.js";
import { assertBoardOrgAccess, assertInstanceAdmin, getActorInfo } from "../../routes/authz.js";
import type { TeamLivenessService } from "./service.js";

export function teamLivenessRoutes(_db: Db, service: TeamLivenessService) {
  const router = Router();

  router.get("/myrmidon/team-liveness", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(await service.read());
  });

  router.patch(
    "/myrmidon/team-liveness",
    validate(patchTeamLivenessSettingsSchema),
    async (req, res) => {
      assertInstanceAdmin(req);
      res.json(await service.update(req.body as TeamLivenessSettingsPatch, getActorInfo(req)));
    },
  );

  return router;
}
