// myrmidon(1.7 AUTO-UPDATE-SETTINGS, OPE-10186): manual update availability routes: GET/POST /api/system/check-updates
import { Router, type Request, type Response } from "express";
import { checkUpdatesRequestSchema } from "@myrmidon/shared";
import { validate } from "../middleware/validate.js";
import { assertBoardOrAgent } from "./authz.js";
import {
  checkSystemUpdates,
  type CheckUpdatesDeps,
} from "../myrmidon/deploy-jobs/check-updates.js";

export function systemUpdatesRoutes(deps?: CheckUpdatesDeps): Router {
  const router = Router();

  const handleCheck = async (req: Request, res: Response) => {
    assertBoardOrAgent(req);
    const result = await checkSystemUpdates(req.body, deps);
    res.json(result);
  };

  const handleGet = async (req: Request, res: Response) => {
    assertBoardOrAgent(req);
    const queryInput = {
      channel: typeof req.query.channel === "string" ? req.query.channel : undefined,
      force: req.query.force === "true" || req.query.force === "1",
      reference: typeof req.query.reference === "string" ? req.query.reference : undefined,
    };
    const parsed = checkUpdatesRequestSchema.parse(
      req.query.channel !== undefined ||
        req.query.force !== undefined ||
        req.query.reference !== undefined
        ? queryInput
        : {},
    );
    const result = await checkSystemUpdates(parsed, deps);
    res.json(result);
  };

  router.post("/system/check-updates", validate(checkUpdatesRequestSchema), handleCheck);
  router.get("/system/check-updates", handleGet);

  // Aliases for parity across surfaces
  router.post("/myrmidon/system/check-updates", validate(checkUpdatesRequestSchema), handleCheck);
  router.get("/myrmidon/system/check-updates", handleGet);
  router.post("/instance-settings/check-updates", validate(checkUpdatesRequestSchema), handleCheck);
  router.get("/instance-settings/check-updates", handleGet);

  return router;
}
