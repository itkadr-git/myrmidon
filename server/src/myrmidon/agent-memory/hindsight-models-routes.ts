import { Router } from "express";
import {
  patchHindsightModelsSchema,
  type PatchHindsightModels,
} from "@myrmidon/shared";
import { validate } from "../../middleware/validate.js";
import { assertBoardOrgAccess, assertInstanceAdmin } from "../../routes/authz.js";
import type { hindsightModelsAdapter } from "./hindsight-models-adapter.js";

export function hindsightModelsRoutes(adapter: ReturnType<typeof hindsightModelsAdapter>) {
  const router = Router();

  router.get("/", async (req, res) => {
    assertBoardOrgAccess(req);
    const catalog = await adapter.getCatalog();
    res.json(catalog);
  });

  router.patch("/", validate(patchHindsightModelsSchema), async (req, res) => {
    assertInstanceAdmin(req);
    const patch = req.body as PatchHindsightModels;
    const updated = await adapter.updateCatalog(patch);
    res.json(updated);
  });

  return router;
}
