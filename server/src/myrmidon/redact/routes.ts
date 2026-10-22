import { and, eq, inArray } from "drizzle-orm";
import { Router } from "express";
import { companies } from "@paperclipai/db";
import { nestRedactConfigSchema } from "@paperclipai/shared";
import { badRequest } from "../../errors.js";
import { assertBoardOrgAccess, assertInstanceAdmin } from "../../routes/authz.js";
import { readNestRedactConfig, writeNestRedactConfig } from "./store.js";
import type { Db } from "@paperclipai/db";

export function nestRedactRoutes(db: Db) {
  const router = Router();
  async function resolveNest(req: Parameters<Parameters<typeof router.get>[1]>[0]) {
    const nestId = String(req.params.nestId);
    const allowedCompanies = req.actor.type === "board" && req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin
      ? req.actor.companyIds ?? []
      : undefined;
    const where = allowedCompanies
      ? and(eq(companies.id, nestId), inArray(companies.id, allowedCompanies))
      : eq(companies.id, nestId);
    const row = await db.select({ id: companies.id }).from(companies).where(where).then((rows) => rows[0]);
    if (!row) throw badRequest("nest not found");
    return nestId;
  }
  router.get("/myrmidon/nests/:nestId/redact", async (req, res) => {
    assertBoardOrgAccess(req);
    const nestId = await resolveNest(req);
    res.json(await readNestRedactConfig(db, nestId));
  });
  router.patch("/myrmidon/nests/:nestId/redact", async (req, res) => {
    assertInstanceAdmin(req);
    const nestId = await resolveNest(req);
    const parsed = nestRedactConfigSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "invalid nest redact config");
    res.json(await writeNestRedactConfig(db, nestId, parsed.data));
  });
  return router;
}
