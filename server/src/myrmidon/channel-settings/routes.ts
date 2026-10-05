// GET/PATCH /api/myrmidon/channel-settings (myrmidon 1.7-SETTINGS-TO-UI).
//
// GET reports the effective channel settings and where each value came from
// (the interface, the environment, or the built-in default); any authenticated
// board member with organisation access may read it. PATCH writes
// `instance_settings.general.channelSettings`, records the change and answers
// with the settings now in force; it is instance-admin only, the same rule the
// rest of the instance settings follow.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { badRequest } from "../../errors.js";
import { assertBoardOrgAccess, assertInstanceAdmin, getActorInfo } from "../../routes/authz.js";
import { parseChannelSettingsPatch, type ChannelSettingsPatch } from "./settings.js";
import type { ChannelSettingsService } from "./service.js";

function readPatch(body: unknown): ChannelSettingsPatch {
  try {
    return parseChannelSettingsPatch(body);
  } catch (err) {
    throw badRequest(err instanceof Error ? err.message : "invalid channel settings patch");
  }
}

export function channelSettingsRoutes(_db: Db, service: ChannelSettingsService) {
  const router = Router();

  router.get("/myrmidon/channel-settings", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(await service.read());
  });

  router.patch("/myrmidon/channel-settings", async (req, res) => {
    assertInstanceAdmin(req);
    res.json(await service.update(readPatch(req.body), getActorInfo(req)));
  });

  return router;
}