// GET/PATCH /api/myrmidon/owner/active-channel and
// POST /api/owner/heartbeat (myrmidon 1.6.6 OPE-10190).
//
// GET answers the question the shell and the owner ask: which channel is the
// owner active in right now — the portal (web) or Telegram — with the last
// touches and the inactivity threshold in force and where its value came
// from (stored settings, the environment override, or the default). Any
// authenticated board member may read their own status; an explicit
// `?userId=` is instance-admin only, the same rule the rest of the instance
// views follow. PATCH writes `instance_settings.general.ownerActiveChannel`;
// instance-admin only. Neither needs a restart.

import { Router } from "express";
import type { Db } from "@myrmidon/db";
import {
  patchOwnerActiveChannelSchema,
  type OwnerActiveChannelPatch,
} from "@myrmidon/shared";
import { validate } from "../../middleware/validate.js";
import { badRequest } from "../../errors.js";
import { assertBoardOrgAccess, assertInstanceAdmin, getActorInfo } from "../../routes/authz.js";
import type { OwnerActiveChannelService } from "./service.js";
import { markOwnerActivity } from "./store.js";

export function ownerActiveChannelRoutes(
  db: Db,
  service: OwnerActiveChannelService,
  touchActivity: typeof markOwnerActivity = markOwnerActivity,
) {
  const router = Router();

  router.post("/owner/heartbeat", async (req, res) => {
    assertBoardOrgAccess(req);
    const userId = req.actor.userId;
    if (!userId) throw badRequest("A board user identity is required");
    await touchActivity(db, { userId, channel: "web" });
    res.json(await service.read(userId));
  });

  router.get("/myrmidon/owner/active-channel", async (req, res) => {
    assertBoardOrgAccess(req);
    const selfUserId = req.actor.userId;
    if (!selfUserId) throw badRequest("A board user identity is required");
    const requested = typeof req.query.userId === "string" ? req.query.userId.trim() : "";
    if (requested && requested !== selfUserId) {
      // Reading someone else's status is an instance-admin view (the same rule
      // the rest of the instance reads follow). A user with no activity rows
      // simply answers with null touches and a null channel.
      assertInstanceAdmin(req);
    }
    res.json(await service.read(requested || selfUserId));
  });

  router.patch(
    "/myrmidon/owner/active-channel",
    validate(patchOwnerActiveChannelSchema),
    async (req, res) => {
      assertInstanceAdmin(req);
      res.json(await service.update(req.body as OwnerActiveChannelPatch, getActorInfo(req)));
    },
  );

  return router;
}
