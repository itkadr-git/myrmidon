import { Router } from "express";
import { ZodError } from "zod";
import {
  patchHindsightModelsSchema,
  type PatchHindsightModels,
} from "@myrmidon/shared";
import { assertBoardOrgAccess, assertInstanceAdmin } from "../../routes/authz.js";
import type { hindsightModelsAdapter } from "./hindsight-models-adapter.js";

export function hindsightModelsRoutes(adapter: ReturnType<typeof hindsightModelsAdapter>) {
  const router = Router();

  router.get("/", async (req, res) => {
    assertBoardOrgAccess(req);
    const catalog = await adapter.getCatalog();
    res.json(catalog);
  });

  router.patch("/", (req, _res, next) => {
    try {
      req.body = patchHindsightModelsSchema.parse(req.body);
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const validationError = new Error("Validation error");
        Object.assign(validationError, { status: 400, details: error.issues });
        next(validationError);
        return;
      }
      next(error);
    }
  }, async (req, res) => {
    assertInstanceAdmin(req);
    const patch = req.body as PatchHindsightModels;
    const updated = await adapter.updateCatalog(patch);
    res.json(updated);
  });

  return router;
}
