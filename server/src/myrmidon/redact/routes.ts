import { Router } from "express";
import { nestRedactConfigSchema } from "@paperclipai/shared";
import { badRequest } from "../../errors.js";
import { assertBoardOrgAccess, assertInstanceAdmin } from "../../routes/authz.js";
import { readNestRedactConfig, writeNestRedactConfig } from "./store.js";
import type { Db } from "@paperclipai/db";

export function nestRedactRoutes(db: Db) {
  const router = Router();
  router.get("/myrmidon/nests/:nestId/redact", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(await readNestRedactConfig(db, String(req.params.nestId)));
  });
  router.patch("/myrmidon/nests/:nestId/redact", async (req, res) => {
    assertInstanceAdmin(req);
    const parsed = nestRedactConfigSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "invalid nest redact config");
    res.json(await writeNestRedactConfig(db, String(req.params.nestId), parsed.data));
  });
  return router;
}
