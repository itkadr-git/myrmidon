import { Router, type Request } from "express";
import type { Db } from "@myrmidon/db";
import {
  blockerGraphRootsResponseSchema,
  DEFAULT_ROOT_FANOUT_LIMIT,
} from "@myrmidon/shared";
import { assertCompanyAccess } from "./authz.js";
import { accessService } from "../services/access.js";
import { loadBlockedGraph } from "../services/blocker-graph/load-edges.js";
import { computeRootFanout } from "../services/blocker-graph/root-fanout.js";

interface BlockerGraphRouteOptions {
  loadGraph?: typeof loadBlockedGraph;
  canReadCompany?: (req: Request, companyId: string) => Promise<boolean>;
}

export function blockerGraphRoutes(db: Db, options: BlockerGraphRouteOptions = {}) {
  const router = Router();
  const loadGraph = options.loadGraph ?? loadBlockedGraph;
  const canReadCompany = options.canReadCompany ?? (async (req, companyId) => {
    const decision = await accessService(db).decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    return decision.allowed;
  });

  router.get("/companies/:companyId/blocker-graph/roots", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    // Aggregates must not expose issue IDs outside a scoped actor's boundary.
    if ((req.actor.type === "agent" && req.actor.keyScope?.kind === "task_bridge") ||
        !(await canReadCompany(req, companyId))) {
      res.status(403).json({ error: "Blocker graph is outside this actor's authorization boundary" });
      return;
    }
    const rawLimit = req.query.limit;
    if (rawLimit !== undefined &&
        (typeof rawLimit !== "string" || !/^\d+$/.test(rawLimit) ||
         !Number.isSafeInteger(Number(rawLimit)) || Number(rawLimit) < 1)) {
      res.status(400).json({ error: "limit must be a positive safe integer" });
      return;
    }
    const limit = rawLimit === undefined ? DEFAULT_ROOT_FANOUT_LIMIT : Number(rawLimit);
    const graph = await loadGraph(db, companyId);
    const roots = computeRootFanout(graph.edges)
      .sort((a, b) => b.dependentCount - a.dependentCount || a.rootIssueId.localeCompare(b.rootIssueId))
      .slice(0, limit);
    const response = blockerGraphRootsResponseSchema.safeParse({
      roots,
      limit,
      generatedAt: new Date().toISOString(),
    });
    if (!response.success) {
      res.status(500).json({ error: "Invalid blocker graph response" });
      return;
    }
    res.json(response.data);
  });
  return router;
}
