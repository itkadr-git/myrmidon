/**
 * tokens-trace — HTTP routes for trace export (OPE-10727).
 *
 * Read-only; mounted under the company-scoped myrmidon API. All endpoints
 * require a board actor with access to the company — there is no cross-company
 * view and agent keys are denied.
 */
import { Router } from "express";
import type { Db } from "@myrmidon/db";
import { z } from "zod";
import { assertBoard, assertCompanyAccess } from "../../routes/authz.js";
import { aggregateByAgent, findPerCallMismatches, reconcilePerCall, reconcileWithSpendLogs } from "./store.js";

export const TOKENS_TRACE_API_BASE = "/myrmidon/companies/:companyId/tokens-trace";

const windowSchema = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
  agentId: z.string().uuid().optional(),
});

export function buildTokensTraceRoutes(deps: { db: Db }): Router {
  const router = Router();

  // GET /myrmidon/companies/:companyId/tokens-trace/agents?from&to&agentId
  // Acceptance #1: per-agent section shares + cache share over a window.
  router.get(`${TOKENS_TRACE_API_BASE}/agents`, async (req, res) => {
    // Board-first, like bot-containers: assertBoard rejects any non-board
    // actor — including credential-less ({type:"none"}, 403) and agent keys —
    // before company scoping runs (OPE-12675).
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const parsed = windowSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_window", detail: parsed.error.issues });
      return;
    }
    const { from, to, agentId } = parsed.data;
    const aggregates = await aggregateByAgent({
      db: deps.db,
      companyId,
      from,
      to,
      agentId,
    });
    res.json({ window: { from, to }, agents: aggregates });
  });

  // GET /myrmidon/companies/:companyId/tokens-trace/reconcile?from&to&detail=calls
  // Acceptance #2: SUM(promptTokens) vs litellm_cost_events over a window.
  // With detail=calls, also returns the per-call join rows and any calls
  // whose prompt tokens diverge from the spend-log row by more than 5% (or
  // that have no spend-log row at all) — row-level evidence for the
  // per-call reconciliation the acceptance criterion requires.
  router.get(`${TOKENS_TRACE_API_BASE}/reconcile`, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const parsed = windowSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_window", detail: parsed.error.issues });
      return;
    }
    const { from, to } = parsed.data;
    const result = await reconcileWithSpendLogs({
      db: deps.db,
      companyId,
      from,
      to,
    });
    if (req.query.detail !== "calls") {
      res.json({ window: { from, to }, ...result });
      return;
    }
    const perCall = await reconcilePerCall({
      db: deps.db,
      companyId,
      from,
      to,
      limit: typeof req.query.limit === "string" ? Number(req.query.limit) : undefined,
    });
    res.json({
      window: { from, to },
      ...result,
      perCall,
      mismatches: findPerCallMismatches(perCall),
    });
  });

  return router;
}
