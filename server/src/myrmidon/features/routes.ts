// myrmidon(FEATURES): GET /api/myrmidon/features and
// PATCH /api/myrmidon/features/:key.
//
// GET returns the registry with the effective config and the live health of
// every feature; any board member may read it (the report names no secret
// value: addresses and key values are reduced to "set" / "not set"). PATCH
// flips the inline switch of a feature that has one and is instance-admin
// only, like the settings it changes.

import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../../middleware/validate.js";
import { assertBoardOrgAccess, assertInstanceAdmin, getActorInfo } from "../../routes/authz.js";
import { FeatureError, featuresService, type FeaturesService } from "./service.js";

const toggleSchema = z.object({ enabled: z.boolean() }).strict();

export function featuresRoutes(_db: Db, service: FeaturesService) {
  const router = Router();

  router.get("/myrmidon/features", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(await service.report({ fresh: req.query.fresh === "1" }));
  });

  router.patch("/myrmidon/features/:key", validate(toggleSchema), async (req, res) => {
    assertInstanceAdmin(req);
    const actor = getActorInfo(req);
    try {
      const view = await service.setEnabled(String(req.params.key), (req.body as { enabled: boolean }).enabled, {
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
      });
      res.json(view);
    } catch (err) {
      if (err instanceof FeatureError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  return router;
}

/** The service of this process: one per database handle, shared by the routes and the sweep. */
const services = new WeakMap<Db, FeaturesService>();

export function sharedFeaturesService(db: Db): FeaturesService {
  let service = services.get(db);
  if (!service) {
    service = featuresService({ db });
    services.set(db, service);
  }
  return service;
}
