// server/src/myrmidon/guardrails/routes.ts
//
// myrmidon(1.6-GRD): the guardrail event journal API.
//
//   GET /api/myrmidon/companies/:companyId/guardrails/events?limit
//
// Read-only, board members with access to the company,
// shaped after the evals routes. The layer is flag-only in 1.6.1: events
// are recorded by the run-output hook, never mutated through the API.

import { Router } from "express";
import type { Db } from "@myrmidon/db";
import { assertBoard, assertCompanyAccess } from "../../routes/authz.js";
import { listGuardrailEvents } from "./events.js";

export interface GuardrailRoutesDeps {
  db: Db;
}

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

export function myrmidonGuardrailsRoutes(db: Db, _deps: Partial<GuardrailRoutesDeps> = {}) {
  const router = Router();

  router.get("/myrmidon/companies/:companyId/guardrails/events", async (req, res) => {
    const companyId = req.params.companyId as string;
    // Board only: the journal is operator data, agents of the company do not read it.
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
    const limit =
      rawLimit !== undefined && Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(Math.floor(rawLimit), MAX_LIMIT)
        : DEFAULT_LIMIT;
    const rawOffset = typeof req.query.offset === "string" ? Number(req.query.offset) : undefined;
    const offset =
      rawOffset !== undefined && Number.isFinite(rawOffset) && rawOffset >= 0
        ? Math.floor(rawOffset)
        : 0;

    const filters = {
      rule: typeof req.query.rule === "string" ? req.query.rule : undefined,
      kind: typeof req.query.kind === "string" ? req.query.kind : undefined,
      mode: typeof req.query.mode === "string" ? req.query.mode : undefined,
      level: typeof req.query.level === "string" ? req.query.level : undefined,
      agentId: typeof req.query.agentId === "string" ? req.query.agentId : undefined,
      agent: typeof req.query.agent === "string" ? req.query.agent : undefined,
      decision: typeof req.query.decision === "string" ? req.query.decision : undefined,
      severity: typeof req.query.severity === "string" ? req.query.severity : undefined,
      surface: typeof req.query.surface === "string" ? req.query.surface : undefined,
      runId: typeof req.query.runId === "string" ? req.query.runId : undefined,
      issueId: typeof req.query.issueId === "string" ? req.query.issueId : undefined,
    };

    const events = await listGuardrailEvents(db, companyId, { limit, offset, filters });
    res.json({ events, count: events.length, limit, offset });
  });

  return router;
}
