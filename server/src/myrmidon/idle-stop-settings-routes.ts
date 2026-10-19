import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { instanceSettingsService } from "../services/instance-settings.js";
import { assertBoardOrgAccess, assertInstanceAdmin } from "../routes/authz.js";
import { validate } from "../middleware/validate.js";
import { idleStopSettingsSchema, patchIdleStopSettingsSchema, normalizeIdleStopSettings, mergeIdleStopSettings } from "@paperclipai/shared";

export function idleStopSettingsRoutes(db: Db, invalidateConfigCache?: () => void) {
  const router = Router();
  const settings = instanceSettingsService(db) as unknown as { getGeneral(): Promise<{ idleStop?: unknown }>; updateGeneral(patch: { idleStop: unknown }): Promise<unknown> };
  router.get("/myrmidon/idle-stop", async (req, res) => {
    assertBoardOrgAccess(req);
    const general = await settings.getGeneral();
    res.json({ settings: normalizeIdleStopSettings(general.idleStop), stored: general.idleStop ?? null });
  });
  router.patch("/myrmidon/idle-stop", validate(patchIdleStopSettingsSchema), async (req, res) => {
    assertInstanceAdmin(req);
    const general = await settings.getGeneral();
    const next = mergeIdleStopSettings(general.idleStop, req.body);
    const parsed = idleStopSettingsSchema.parse(next);
    await settings.updateGeneral({ idleStop: parsed });
    invalidateConfigCache?.();
    res.json({ settings: parsed, stored: parsed });
  });
  return router;
}