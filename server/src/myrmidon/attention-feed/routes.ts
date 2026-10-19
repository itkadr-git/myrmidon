import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  patchAttentionFeedSettingsSchema,
  type AttentionFeedSettingsPatch,
} from "@paperclipai/shared";
import { validate } from "../../middleware/validate.js";
import { assertBoardOrgAccess, assertInstanceAdmin, getActorInfo } from "../../routes/authz.js";
import type { AttentionFeedService } from "./service.js";

/**
 * GET/PATCH /api/myrmidon/attention-feed (myrmidon 1.6.6 SETTINGS-UI, part C-4).
 *
 * GET reports the two windows the attention feed is built with — the
 * failed-run horizon in days and the per-company cache TTL in seconds — plus
 * the bounds and whether each value comes from the stored settings row or the
 * default. Any authenticated board member may read it — it is the same row the
 * settings screen shows. PATCH writes
 * `instance_settings.general.attentionFailedRunHorizonDays` /
 * `.attentionFeedCacheTtlSeconds` and is instance-admin only, the same rule the
 * rest of the instance settings follow. Neither call restarts anything: the
 * feed reads the row on its next build.
 */

export function attentionFeedRoutes(_db: Db, service: AttentionFeedService) {
  const router = Router();

  router.get("/myrmidon/attention-feed", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(await service.read());
  });

  router.patch(
    "/myrmidon/attention-feed",
    validate(patchAttentionFeedSettingsSchema),
    async (req, res) => {
      assertInstanceAdmin(req);
      res.json(
        await service.update(req.body as AttentionFeedSettingsPatch, getActorInfo(req)),
      );
    },
  );

  return router;
}