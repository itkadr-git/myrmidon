// GET/PATCH /api/myrmidon/bot-disk (myrmidon 1.6.1-BOT-DISK-B).
//
// The shared package cache of development bots: one host directory whose
// subdirectories (template.ts PACKAGE_CACHE_MOUNTS) every bot on the default
// host mounts read-write, so pnpm, Go and Gradle downloads are kept once.
//
// GET reports the stored path; any authenticated board member may read it.
// PATCH writes `instance_settings.general.botDisk` and is instance-admin only,
// the same rule the rest of the instance settings follow. Nothing is pushed to
// a running component: the local driver and the profile compiler re-read the
// row on every reconcile pass, so a change applies on the next pass (bots are
// recreated with the new binds) without restarting the server.
//
// The path must also be dockergate's `packageCacheRoot`: the gate refuses the
// cache binds under any other root (docs/myrmidon/SETTINGS.md).

import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { badRequest } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { assertBoardOrgAccess, assertInstanceAdmin, getActorInfo } from "../../routes/authz.js";
import { readBotDiskSettings, writeBotDiskSettings, type BotDiskSettings } from "./bot-disk-store.js";
import { sharedPackageCachePathProblem } from "./template.js";

/** null or "" clears the setting (no shared cache). */
export const patchBotDiskSettingsSchema = z
  .object({
    sharedPackageCachePath: z.string().max(4096).nullable(),
  })
  .strict();

export interface BotDiskView {
  sharedPackageCachePath: string | null;
}

function view(settings: BotDiskSettings): BotDiskView {
  return { sharedPackageCachePath: settings.sharedPackageCachePath ?? null };
}

export function botDiskApi(db: Db) {
  const router = Router();

  router.get("/myrmidon/bot-disk", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(view(await readBotDiskSettings(db)));
  });

  router.patch("/myrmidon/bot-disk", async (req, res) => {
    assertInstanceAdmin(req);
    const parsed = patchBotDiskSettingsSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid bot disk settings", parsed.error.issues);
    const path = parsed.data.sharedPackageCachePath?.trim() || undefined;
    if (path) {
      const problem = sharedPackageCachePathProblem(path);
      if (problem) throw badRequest(`sharedPackageCachePath ${problem}`);
    }
    const saved = await writeBotDiskSettings(db, { sharedPackageCachePath: path });
    const actor = getActorInfo(req);
    logger.info(
      { actorType: actor.actorType, actorId: actor.actorId, sharedPackageCachePath: saved.sharedPackageCachePath ?? null },
      "bot disk settings updated; bots are recreated with the new package cache binds on the next reconcile pass",
    );
    res.json(view(saved));
  });

  return router;
}
