// server/src/myrmidon/tracing-health/routes.ts
//
// myrmidon(TRACING-HEALTH): the API behind the "LLM tracing" status card.
//
//   GET /api/myrmidon/companies/:companyId/tracing/health
//
// Board actors only, with company access: the card names the instance's
// tracing topology (ClickHouse reachability, callback failure counts), which
// is operator territory — the same rule the bot-container and memory routes
// apply. While the instance switch is off the endpoint still answers 200
// with `enabled: false` (not 503), so the UI can say why instead of showing
// a bare error: unlike the data routes (M2-A), this IS the health surface,
// and "not configured" is itself the state an operator must see.
//
// Mutations: none. The check is read-only by construction (GET only, probes
// are GETs), so no activity log row per read — the operator attention signal
// (the attention feed integration) is the durable trace.

import { Router, type Request } from "express";
import { forbidden } from "../../errors.js";
import { assertCompanyAccess } from "../../routes/authz.js";
import { defaultTracingHealthDeps, tracingHealthService } from "./index.js";
import type { TracingHealthCard } from "./service.js";

export interface TracingHealthRoutesDeps {
  /** Board-only gate; throws to deny. */
  assertBoard(req: Request): void;
  /** Company access check (same rule as the bot-container routes). */
  assertCompanyAccess(req: Request, companyId: string): void;
  /** Service factory wired to a db, overridable in tests. */
  service(db: Parameters<typeof tracingHealthService>[0]["db"]): ReturnType<typeof tracingHealthService>;
}

export function tracingHealthRoutes(
  db: Parameters<typeof tracingHealthService>[0]["db"],
  input: TracingHealthRoutesDeps,
) {
  const router = Router();

  router.get("/myrmidon/companies/:companyId/tracing/health", async (req, res) => {
    const companyId = req.params.companyId as string;
    input.assertBoard(req);
    input.assertCompanyAccess(req, companyId);
    const service = input.service(db);
    try {
      res.json(await service.evaluate(companyId));
    } catch {
      // The probes already carry their own error state inside the card; an
      // unexpected throw (secret store down) degrades to "not enabled" rather
      // than a 500 on a health surface.
      res.json(notEnabledCard(new Date().toISOString()));
    }
  });

  return router;
}

function notEnabledCard(checkedAt: string): TracingHealthCard {
  return {
    status: "ok",
    checks: {
      gatewayTraffic: { ok: true, note: "not evaluated" },
      eventsCore: { ok: true, note: "not evaluated", count: null },
      callbackErrors: { ok: true, note: "not evaluated", failures: null },
    },
    summary:
      "LLM tracing health is not enabled: set MYRMIDON_TRACING_CLICKHOUSE_URL, MYRMIDON_TRACING_CLICKHOUSE_KEY_SECRET, MYRMIDON_TRACING_LITELLM_METRICS_URL and MYRMIDON_TRACING_LITELLM_KEY_SECRET.",
    enabled: false,
    windowMs: 15 * 60 * 1000,
    checkedAt,
  };
}

/** The real wiring for app.ts. */
export function myrmidonTracingHealthRoutes(db: Parameters<typeof tracingHealthService>[0]["db"]) {
  return tracingHealthRoutes(db, {
    assertBoard(req) {
      if (req.actor?.type !== "board") throw forbidden("Board access required");
    },
    assertCompanyAccess(req, companyId) {
      assertCompanyAccess(req, companyId);
    },
    service(dbArg) {
      return tracingHealthService(defaultTracingHealthDeps(dbArg));
    },
  });
}
