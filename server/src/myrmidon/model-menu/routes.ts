import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  fitsModelMenuLimits,
  patchModelMenuSettingsSchema,
  type ModelMenuSettingsPatch,
} from "@paperclipai/shared";
import { validate } from "../../middleware/validate.js";
import { assertBoardOrgAccess, assertInstanceAdmin, getActorInfo } from "../../routes/authz.js";
import type { ModelMenuService } from "./service.js";

/**
 * GET/PATCH /api/myrmidon/model-menu (myrmidon 1.6.6 MODEL-MENU, part B).
 *
 * GET reports the setting in force — the stored tree, the catalog it was
 * resolved against and the menu the bot would show, groups and all. The
 * optional `adapterType` query picks the catalog; without it the gateway
 * adapter of the Telegram bot is used. Any authenticated board member may read
 * it, and the value is read from the settings row on every call, so the editor
 * never shows a cached menu.
 *
 * PATCH writes `instance_settings.general.modelMenu` and is instance-admin
 * only, the same rule the rest of the instance settings follow. The tree's own
 * limits (depth, width, model count) live in the walker rather than in the
 * schema, so they are checked here: a body that would be dropped by the
 * resolver on every read is refused with 400 instead of stored.
 */

export function modelMenuRoutes(_db: Db, service: ModelMenuService) {
  const router = Router();

  router.get("/myrmidon/model-menu", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(await service.read({ adapterType: requestedAdapterType(req.query.adapterType) }));
  });

  router.patch(
    "/myrmidon/model-menu",
    validate(patchModelMenuSettingsSchema),
    async (req, res) => {
      assertInstanceAdmin(req);
      const patch = req.body as ModelMenuSettingsPatch;
      if (patch.groups !== undefined && !fitsModelMenuLimits(patch.groups, 1)) {
        res.status(400).json({ error: "model_menu_tree_too_large" });
        return;
      }
      res.json(
        await service.update(patch, getActorInfo(req), {
          adapterType: requestedAdapterType(req.query.adapterType),
        }),
      );
    },
  );

  return router;
}

/** `?adapterType=` accepts one value; anything else means "use the default". */
function requestedAdapterType(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}