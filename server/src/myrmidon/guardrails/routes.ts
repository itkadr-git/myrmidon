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
import type { Db } from "@paperclipai/db";
import { assertBoard, assertCompanyAccess } from "../../routes/authz.js";
import { listGuardrailEvents } from "./events.js";
import { redactText, restoreText, drizzleRedactionStore, type DetectedRedactionEntity, type RedactionMode } from "./entities/redaction.js";

export interface GuardrailRoutesDeps {
  db: Db;
}

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

export function myrmidonGuardrailsRoutes(db: Db, _deps: Partial<GuardrailRoutesDeps> = {}) {
  const router = Router();

  router.post("/myrmidon/guardrails/redact", async (req, res) => {
    const { text, entities, mode, ttlMs } = req.body as {
      text?: unknown;
      entities?: unknown;
      mode?: unknown;
      ttlMs?: unknown;
    };
    if (typeof text !== "string" || !Array.isArray(entities) || !["reversible", "irreversible", "flag"].includes(mode as string)) {
      res.status(400).json({ error: "text, entities, and a supported mode are required" });
      return;
    }
    const normalized = entities.filter((entity): entity is DetectedRedactionEntity => {
      if (!entity || typeof entity !== "object") return false;
      const value = entity as Record<string, unknown>;
      return typeof value.type === "string" && typeof value.value === "string" && typeof value.start === "number" && typeof value.end === "number";
    });
    if (normalized.length !== entities.length) {
      res.status(400).json({ error: "entities must contain type, value, start, and end" });
      return;
    }
    const ttl = ttlMs === undefined ? undefined : Number(ttlMs);
    if (ttl !== undefined && (!Number.isFinite(ttl) || ttl <= 0)) {
      res.status(400).json({ error: "ttlMs must be a positive number" });
      return;
    }
    const result = await redactText(text, normalized, mode as RedactionMode, drizzleRedactionStore(db), { ttlMs: ttl });
    res.json(result);
  });

  router.post("/myrmidon/guardrails/restore", async (req, res) => {
    const { redactionId, text } = req.body as { redactionId?: unknown; text?: unknown };
    if (typeof redactionId !== "string" || typeof text !== "string") {
      res.status(400).json({ error: "redactionId and text are required" });
      return;
    }
    res.json({ text: await restoreText(drizzleRedactionStore(db), redactionId, text) });
  });

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
    const events = await listGuardrailEvents(db, companyId, limit);
    res.json({ events, count: events.length, limit });
  });

  return router;
}
