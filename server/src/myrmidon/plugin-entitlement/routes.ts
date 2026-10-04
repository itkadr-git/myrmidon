// server/src/myrmidon/plugin-entitlement/routes.ts
//
// myrmidon(PLUGIN-ENTITLEMENT C / 1.6.3 A): the instance settings API.
//
// - GET    /api/myrmidon/plugin-entitlement/keys — the accepted keys as
//   `[{ pluginId, expiresAt, acceptedAt }]` (never the key values — the
//   acceptance criterion is that a key value is not returned by the API).
//   Instance admins only (the list is the licensing state of the whole
//   instance).
// - POST   /api/myrmidon/plugin-entitlement/keys — accept a key
//   `{ pluginId, key }`. The key must be a valid PEK1 ed25519 token whose
//   signature verifies against the instance verification public key and
//   whose plugin/instance/expiry scope matches. A duplicate pluginId
//   replaces its previous key. The expiry is taken from the token payload.
// - DELETE /api/myrmidon/plugin-entitlement/keys/:pluginId — remove the key.
// - GET    /api/myrmidon/plugin-entitlement/public-key — the effective
//   ed25519 verification public key and where the value came from
//   (`settings`, `env`, `none`).
// - PUT    /api/myrmidon/plugin-entitlement/public-key — store or clear the
//   verification public key in the instance settings.
//
// Accepting a key takes effect without a restart: the loader gate re-reads
// the settings row on every activation pass.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { toPluginEntitlementKeyViews } from "@paperclipai/shared";
import { resolvePaperclipInstanceId } from "@paperclipai/shared";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { assertInstanceAdmin } from "../../routes/authz.js";
import {
  acceptKeyRequestSchema,
  setPublicKeyRequestSchema,
  validateIncomingKey,
  verifyEntitlementToken,
  entitlementTokenErrorMessage,
  isValidEd25519PublicKey,
} from "./validation.js";
import {
  acceptPluginEntitlementKey,
  readPluginEntitlementKeys,
  readPluginEntitlementPublicKeyWithSource,
  removePluginEntitlementKey,
  writePluginEntitlementPublicKey,
} from "./store.js";

export function pluginEntitlementRoutes(db: Db) {
  const router = Router();
  const settings = instanceSettingsService(db);

  router.get("/myrmidon/plugin-entitlement/keys", async (req, res) => {
    assertInstanceAdmin(req);
    // Views only: the stored entries carry the raw tokens; the response never
    // does (acceptance criterion — a key value must not leave the server).
    res.json(toPluginEntitlementKeyViews(await readPluginEntitlementKeys(settings)));
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
    // Cryptographic gate: the token must verify against the instance's
    // public key and match this instance and plugin. The expiry comes from
    // the signed payload, not from the request body.
    const { publicKey: publicKeyPem } = await readPluginEntitlementPublicKeyWithSource(settings);
    const tokenVerdict = verifyEntitlementToken(parsed.data.key, {
      publicKeyPem: publicKeyPem ?? "",
      instanceId: resolvePaperclipInstanceId(),
      pluginId: parsed.data.pluginId.trim(),
    });
    if (!tokenVerdict.valid) {
      // The error message carries the failure reason only — no key material.
      res.status(400).json({ error: entitlementTokenErrorMessage(tokenVerdict) });
      return;
    }
    const keys = await acceptPluginEntitlementKey(settings, {
      pluginId: parsed.data.pluginId,
      key: parsed.data.key,
      expiresAt: tokenVerdict.expiresAt,
    });
    res.status(201).json(toPluginEntitlementKeyViews(keys));
  });

  router.delete("/myrmidon/plugin-entitlement/keys/:pluginId", async (req, res) => {
    assertInstanceAdmin(req);
    const keys = await removePluginEntitlementKey(settings, req.params.pluginId);
    res.json(toPluginEntitlementKeyViews(keys));
  });

  router.get("/myrmidon/plugin-entitlement/public-key", async (req, res) => {
    assertInstanceAdmin(req);
    // The public key itself is not secret, and the source tells the admin
    // whether the value is an instance setting or the forced env override.
    res.json(await readPluginEntitlementPublicKeyWithSource(settings));
  });

  router.put("/myrmidon/plugin-entitlement/public-key", async (req, res) => {
    assertInstanceAdmin(req);
    const parsed = setPublicKeyRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "publicKey must be a string or null" });
      return;
    }
    const value = parsed.data.publicKey?.trim() ? parsed.data.publicKey.trim() : null;
    if (value !== null && !isValidEd25519PublicKey(value)) {
      // A clear, actionable message: the admin pasted something that is not
      // an ed25519 public key. No key material in the message.
      res.status(400).json({ error: "publicKey must be an ed25519 public key in PEM format" });
      return;
    }
    await writePluginEntitlementPublicKey(settings, value);
    res.json(await readPluginEntitlementPublicKeyWithSource(settings));
  });

  return router;
}
