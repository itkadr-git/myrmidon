// server/src/myrmidon/castes/nests-routes.ts
//
// myrmidon(1.6.5 F-26 T3 CASTES-AND-NESTS): the REST API of the agent nests.
//
//   GET /api/myrmidon/companies/:companyId/agents/:agentId/nests   (company access)
//   PUT /api/myrmidon/companies/:companyId/agents/:agentId/nests   (board only)
//
// The GET answers { companyId, agentId, projectIds } — an empty list is "the
// whole company". The PUT replaces the whole set (body { projectIds: [...] }),
// which is what the multi-select in the agent card sends.
//
// Authorization mirrors the caste routes: assertCompanyAccess on the read,
// assertBoard on the write. No database or service imports: everything arrives
// through deps, so the suite runs these routes with fakes (wiring.ts is the only
// file that knows about `Db`).

import { Router, type Request } from "express";
import { agentNestsBodySchema } from "@paperclipai/shared";
import { badRequest } from "../../errors.js";
import { assertBoard, assertCompanyAccess } from "../../routes/authz.js";
import type { AgentNestService } from "./nests-service.js";

/** The activity row of one nests save. */
export interface AgentNestActivityEntry {
  companyId: string;
  agentId: string;
  projectIds: string[];
  added: string[];
  removed: string[];
}

export interface AgentNestRoutesDeps {
  service: AgentNestService;
  /** Writes the save into the company activity log. Optional: tests pass none. */
  recordActivity?: (entry: AgentNestActivityEntry) => Promise<void>;
}

function bodyOf(req: Request): Record<string, unknown> {
  const body = req.body;
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

export function agentNestRoutes(deps: AgentNestRoutesDeps): Router {
  const router = Router();
  const param = (req: Request, name: string): string => String(req.params[name] ?? "");

  router.get("/myrmidon/companies/:companyId/agents/:agentId/nests", async (req, res, next) => {
    try {
      const companyId = param(req, "companyId");
      const agentId = param(req, "agentId");
      assertCompanyAccess(req, companyId);
      res.json(await deps.service.getNests(companyId, agentId));
    } catch (error) {
      next(error);
    }
  });

  router.put("/myrmidon/companies/:companyId/agents/:agentId/nests", async (req, res, next) => {
    try {
      const companyId = param(req, "companyId");
      const agentId = param(req, "agentId");
      assertCompanyAccess(req, companyId);
      assertBoard(req);
      const parsed = agentNestsBodySchema.safeParse(bodyOf(req));
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        throw badRequest(first?.message ?? "invalid request body");
      }
      const change = await deps.service.putNests({
        companyId,
        agentId,
        projectIds: parsed.data.projectIds,
      });
      if (deps.recordActivity) {
        await deps.recordActivity({
          companyId,
          agentId,
          projectIds: change.view.projectIds,
          added: change.added,
          removed: change.removed,
        });
      }
      res.json(change.view);
    } catch (error) {
      next(error);
    }
  });

  return router;
}