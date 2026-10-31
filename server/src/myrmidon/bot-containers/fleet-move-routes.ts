// server/src/myrmidon/bot-containers/fleet-move-routes.ts
//
// myrmidon(1.6.6 REMOTE-SITES-T5): fleet bot move endpoints.
//
//   POST /fleet/bots/:key/move              — trigger or resume bot migration
//   GET  /fleet/bots/:key/move              — query latest move status & phaseLog
//   POST /api/myrmidon/fleet/bots/:key/move — api-prefixed alias
//   GET  /api/myrmidon/fleet/bots/:key/move — api-prefixed alias
//
// The bot key is the agent id; the company is the bot's own (read from its card), never
// taken from the request, and the caller must have access to it.

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { badRequest, conflict, notFound } from "../../errors.js";
import { assertBoard, assertCompanyAccess } from "../../routes/authz.js";
import { FleetMoveError, type FleetMoveService } from "./fleet-move-service.js";

const moveBodySchema = z.object({
  to: z.string().trim().min(1).optional(),
  toSite: z.string().trim().min(1).optional(),
});

export interface FleetMoveRoutesDeps {
  service: Pick<FleetMoveService, "startMove" | "getLatestMove">;
  /** The company that owns the bot, or null when there is no such bot. */
  botCompanyId: (botKey: string) => Promise<string | null>;
  getSiteLogs: (siteName: string, companyId: string, botKey: string, tail?: number) => Promise<string>;
}

export function fleetMoveRoutes(deps: FleetMoveRoutesDeps): Router {
  const router = Router();

  async function authorizedCompany(req: Request, botKey: string): Promise<string> {
    assertBoard(req);
    const companyId = await deps.botCompanyId(botKey);
    if (!companyId) throw notFound(`Bot "${botKey}" not found`);
    assertCompanyAccess(req, companyId);
    return companyId;
  }

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

    const companyId = await authorizedCompany(req, botKey);

    let result;
    try {
      result = await deps.service.startMove({ companyId, botKey, dstSite });
    } catch (err) {
      if (err instanceof FleetMoveError) {
        throw err.kind === "not_found" ? notFound(err.message) : conflict(err.message);
      }
      throw err;
    }

    res.status(result.phase === "failed" ? 500 : 200).json({ move: result });
  }

  async function handleMoveGet(req: Request, res: Response): Promise<void> {
    assertBoard(req);

    const botKey = typeof req.params.key === "string" ? req.params.key : undefined;
    if (!botKey) throw badRequest("botKey required");

    const companyId = await authorizedCompany(req, botKey);

    const move = await deps.service.getLatestMove(companyId, botKey);
    if (!move) {
      throw notFound(`No fleet move found for bot "${botKey}"`);
    }

    res.json({ move });
  }

  async function handleLogsGet(req: Request, res: Response): Promise<void> {
    assertBoard(req);
    const botKey = typeof req.params.key === "string" ? req.params.key : undefined;
    const site = typeof req.query.site === "string" ? req.query.site : undefined;
    const tail = req.query.tail === undefined ? 100 : Number(req.query.tail);
    if (!botKey || !site) throw badRequest("botKey and site are required");
    if (!Number.isInteger(tail) || tail < 1 || tail > 1000) throw badRequest("tail must be an integer between 1 and 1000");
    const companyId = await authorizedCompany(req, botKey);
    if (!deps.getSiteLogs) throw conflict("site-agent logs are unavailable");
    res.type("text/plain").send(await deps.getSiteLogs(site, companyId, botKey, tail));
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
  router.get("/fleet/bots/:key/logs", (req, res, next) => { void handleLogsGet(req, res).catch(next); });
  router.get("/api/myrmidon/fleet/bots/:key/logs", (req, res, next) => { void handleLogsGet(req, res).catch(next); });

  return router;
}
