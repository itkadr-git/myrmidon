// GET /api/myrmidon/owner/active-channel and
// PATCH /api/myrmidon/owner/active-channel (myrmidon 1.7-ACTIVE-CHANNEL).
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
import type { Db } from "@paperclipai/db";
import {
  patchOwnerActiveChannelSchema,
  type OwnerActiveChannelPatch,
} from "@paperclipai/shared";
import { validate } from "../../middleware/validate.js";
import { badRequest } from "../../errors.js";
import { assertBoardOrgAccess, assertInstanceAdmin, getActorInfo } from "../../routes/authz.js";
import type { OwnerActiveChannelService } from "./service.js";

export function ownerActiveChannelRoutes(_db: Db, service: OwnerActiveChannelService) {
  const router = Router();

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
