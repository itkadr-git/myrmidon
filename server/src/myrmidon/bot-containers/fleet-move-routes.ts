// server/src/myrmidon/bot-containers/fleet-move-routes.ts
//
// myrmidon(1.6.6 REMOTE-SITES-T5): fleet bot move endpoints.
//
//   POST /fleet/bots/:key/move              — trigger or resume bot migration
//   GET  /fleet/bots/:key/move              — query latest move status & phaseLog
//   POST /api/myrmidon/fleet/bots/:key/move — api-prefixed alias
//   GET  /api/myrmidon/fleet/bots/:key/move — api-prefixed alias

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { badRequest, notFound } from "../../errors.js";
import { assertBoard } from "../../routes/authz.js";
import type { FleetMoveService, FleetMoveRecord } from "./fleet-move-service.js";

const moveBodySchema = z.object({
  to: z.string().trim().min(1).optional(),
  toSite: z.string().trim().min(1).optional(),
  companyId: z.string().uuid().optional(),
});

export interface FleetMoveRoutesDeps {
  service: FleetMoveService;
  resolveCompanyIdForBot?: (botKey: string) => Promise<string | null>;
}

export function fleetMoveRoutes(deps: FleetMoveRoutesDeps): Router {
  const router = Router();

  async function handleMovePost(req: Request, res: Response): Promise<void> {
    assertBoard(req);

    const botKey = typeof req.params.key === "string" ? req.params.key : undefined;
    if (!botKey) throw badRequest("botKey required");

    const parsed = moveBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw badRequest("Invalid move request body: 'to' or 'toSite' required");
    }

    const dstSite = parsed.data.to ?? parsed.data.toSite;
    if (!dstSite) {
      throw badRequest("Target site ('to' or 'toSite') required");
    }

    let companyId = parsed.data.companyId;
    if (!companyId && deps.resolveCompanyIdForBot) {
      const resolved = await deps.resolveCompanyIdForBot(botKey);
      if (resolved) companyId = resolved;
    }
    if (!companyId) {
      companyId = "00000000-0000-0000-0000-000000000000"; // fallback if single company
    }

    const result = await deps.service.startMove({
      companyId,
      botKey,
      dstSite,
    });

    res.status(result.phase === "failed" ? 500 : 200).json({ move: result });
  }

  async function handleMoveGet(req: Request, res: Response): Promise<void> {
    assertBoard(req);

    const botKey = typeof req.params.key === "string" ? req.params.key : undefined;
    if (!botKey) throw badRequest("botKey required");

    let companyId: string | undefined = typeof req.query.companyId === "string" ? req.query.companyId : undefined;
    if (!companyId && deps.resolveCompanyIdForBot) {
      const resolved = await deps.resolveCompanyIdForBot(botKey);
      if (resolved) companyId = resolved;
    }
    if (!companyId) {
      companyId = "00000000-0000-0000-0000-000000000000";
    }

    const move = await deps.service["deps"].getLatestMoveForBot(companyId, botKey);
    if (!move) {
      throw notFound(`No fleet move found for bot "${botKey}"`);
    }

    res.json({ move });
  }

  // Both unprefixed and /api/myrmidon prefixed paths
  router.post("/fleet/bots/:key/move", (req, res, next) => {
    void handleMovePost(req, res).catch(next);
  });
  router.get("/fleet/bots/:key/move", (req, res, next) => {
    void handleMoveGet(req, res).catch(next);
  });
  router.post("/api/myrmidon/fleet/bots/:key/move", (req, res, next) => {
    void handleMovePost(req, res).catch(next);
  });
  router.get("/api/myrmidon/fleet/bots/:key/move", (req, res, next) => {
    void handleMoveGet(req, res).catch(next);
  });

  return router;
}
