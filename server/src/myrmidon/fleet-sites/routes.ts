import { Router, type Request } from "express";
import { z } from "zod";
import { HttpError } from "../../errors.js";
import { validate } from "../../middleware/validate.js";
import { assertBoard, assertCompanyAccess } from "../../routes/authz.js";
import { fleetSitePatchSchema, fleetSiteSchema } from "./domain.js";
import type { FleetSiteStore } from "./store.js";

function assertOperator(req: Request, companyId: string): void {
  assertBoard(req);
  assertCompanyAccess(req, companyId);
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
  const membership = req.actor.memberships?.find((item) => item.companyId === companyId);
  if (membership?.status === "active" && membership.membershipRole === "owner") return;
  throw new HttpError(403, "Company owner access required");
}

const patchSchema = fleetSitePatchSchema.extend({ slug: z.string().trim().min(1).max(63) });

export function fleetSiteRoutes(deps: { store: FleetSiteStore }) {
  const router = Router();
  router.get("/myrmidon/fleet/sites", async (req, res) => {
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId : "";
    if (!companyId) throw new HttpError(400, "companyId is required");
    assertOperator(req, companyId);
    res.json({ sites: await deps.store.list(companyId) });
  });
  router.post("/myrmidon/fleet/sites", validate(fleetSiteSchema), async (req, res) => {
    const input = req.body as z.infer<typeof fleetSiteSchema>;
    assertOperator(req, input.companyId);
    res.status(201).json({ site: await deps.store.create(input) });
  });
  router.patch("/myrmidon/fleet/sites", validate(patchSchema), async (req, res) => {
    const input = req.body as z.infer<typeof patchSchema>;
    assertOperator(req, input.companyId);
    const site = await deps.store.patch(input.companyId, input.slug, input.status);
    if (!site) throw new HttpError(404, "Fleet site not found");
    res.json({ site });
  });
  return router;
}
