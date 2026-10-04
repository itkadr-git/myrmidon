// server/src/myrmidon/plugin-entitlement/routes.ts
//
// myrmidon(PLUGIN-ENTITLEMENT C): the instance settings API.
//
// - GET    /api/myrmidon/plugin-entitlement/keys — the accepted keys
//   `[{ pluginId, key, expiresAt, acceptedAt }]`. Instance admins only (the
//   list is the licensing state of the whole instance).
// - POST   /api/myrmidon/plugin-entitlement/keys — accept a key
//   `{ pluginId, key }`; a duplicate pluginId replaces its previous key.
// - DELETE /api/myrmidon/plugin-entitlement/keys/:pluginId — remove the key.
//
// Accepting a key takes effect without a restart: the loader gate re-reads
// the settings row on every activation pass.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { assertInstanceAdmin } from "../../routes/authz.js";
import { acceptKeyRequestSchema, validateIncomingKey } from "./validation.js";
import { acceptPluginEntitlementKey, readPluginEntitlementKeys, removePluginEntitlementKey } from "./store.js";

export function pluginEntitlementRoutes(db: Db) {
  const router = Router();
  const settings = instanceSettingsService(db);

  router.get("/myrmidon/plugin-entitlement/keys", async (req, res) => {
    assertInstanceAdmin(req);
    res.json(await readPluginEntitlementKeys(settings));
  });

  router.post("/myrmidon/plugin-entitlement/keys", async (req, res) => {
    assertInstanceAdmin(req);
    const parsed = acceptKeyRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "pluginId and key are required" });
      return;
    }
    const verdict = validateIncomingKey(parsed.data);
    if (!verdict.ok) {
      // A clear, actionable message for a bad key — the acceptance criterion
      // of the feature is "an invalid key gives a understandable error".
      res.status(400).json({ error: verdict.error });
      return;
    }
    const keys = await acceptPluginEntitlementKey(settings, parsed.data);
    res.status(201).json(keys);
  });

  router.delete("/myrmidon/plugin-entitlement/keys/:pluginId", async (req, res) => {
    assertInstanceAdmin(req);
    const keys = await removePluginEntitlementKey(settings, req.params.pluginId);
    res.json(keys);
  });

  return router;
}
