// server/src/myrmidon/guardrails/routes.ts
//
// myrmidon(1.6-GRD): the guardrail event journal API.
//
//   GET /api/myrmidon/companies/:companyId/guardrails/events?limit
//
// Read-only, company access (board members and the company's own agents),
// shaped after the evals routes. The layer is flag-only in 1.6.1: events
// are recorded by the run-output hook, never mutated through the API.
//
// myrmidon(1.7-GRD-MODES) (OPE-4167): the settings and the filtered journal.
//
//   GET /api/myrmidon/companies/:companyId/guardrails/settings -> settings
//   PUT /api/myrmidon/companies/:companyId/guardrails/settings (board) -> settings
//   GET /api/myrmidon/companies/:companyId/guardrails/resolve?agentId=&rule=
//        -> the effective mode for one agent/rule, with its source
//   GET /api/myrmidon/companies/:companyId/guardrails/events?limit&kind&severity&surface&runId&since
//
// Reads need company access; the settings PUT needs a board actor — the
// blocking policy is the operator's control, so an agent never edits the
// mode that governs its own runs. The settings live in
// instance_settings.general.guardrailModes; a PUT takes effect on the next
// guardrail evaluation, no restart.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { guardrailModesSettingsSchema, type GuardrailModesSettings } from "@paperclipai/shared";
import { assertCompanyAccess, assertBoard, getActorInfo } from "../../routes/authz.js";
import { logActivity } from "../../services/activity-log.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { listGuardrailEvents } from "./events.js";
import {
  readGuardrailModesSettings,
  writeGuardrailModesSettings,
} from "./modes-settings.js";
import { loadGuardrailModes } from "./modes.js";
import { resolveGuardrailMode } from "@paperclipai/shared";
import { GUARDRAIL_RULES } from "@paperclipai/shared";
import { validate } from "../../middleware/validate.js";
import { badRequest } from "../../errors.js";

export interface GuardrailRoutesDeps {
  db: Db;
}

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

export function myrmidonGuardrailsRoutes(db: Db, _deps: Partial<GuardrailRoutesDeps> = {}) {
  const router = Router();
  const settings = instanceSettingsService(db);

  // --- settings (1.7-GRD-MODES) --------------------------------------------

  router.get("/myrmidon/companies/:companyId/guardrails/settings", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await readGuardrailModesSettings(settings));
  });

  router.put(
    "/myrmidon/companies/:companyId/guardrails/settings",
    validate(guardrailModesSettingsSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertBoard(req);
      const stored = await writeGuardrailModesSettings(settings, req.body as GuardrailModesSettings);
      const info = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: info.actorType === "user" ? info.actorId : "board",
        action: "guardrails.modes_settings_updated",
        entityType: "company",
        entityId: companyId,
        details: {
          summary: "Guardrail enforcement modes changed.",
          company: stored.company,
          castes: Object.keys(stored.castes),
          agentCount: Object.keys(stored.agents).length,
        },
      });
      res.json(stored);
    },
  );

  // --- effective mode with its source (1.7-GRD-MODES) ----------------------

  router.get("/myrmidon/companies/:companyId/guardrails/resolve", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const agentId = typeof req.query.agentId === "string" ? req.query.agentId : "";
    if (!agentId) throw badRequest("agentId query parameter is required");
    const loaded = await loadGuardrailModes({ db, companyId, agentId, env: process.env });
    res.json({
      agentRole: loaded.agentRole,
      forced: loaded.forced,
      rules: GUARDRAIL_RULES.map((rule) =>
        resolveGuardrailMode({
          settings: loaded.settings,
          rule,
          agentId,
          agentRole: loaded.agentRole,
          forced: loaded.forced,
        }),
      ),
    });
  });

  // --- journal (1.6-GRD), with filters (1.7-GRD-MODES) ---------------------

  router.get("/myrmidon/companies/:companyId/guardrails/events", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
    const limit =
      rawLimit !== undefined && Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(Math.floor(rawLimit), MAX_LIMIT)
        : DEFAULT_LIMIT;
    const events = await listGuardrailEvents(db, companyId, limit, {
      kind: typeof req.query.kind === "string" ? req.query.kind : undefined,
      severity: typeof req.query.severity === "string" ? req.query.severity : undefined,
      surface: typeof req.query.surface === "string" ? req.query.surface : undefined,
      runId: typeof req.query.runId === "string" ? req.query.runId : undefined,
    });
    res.json({ events, count: events.length, limit });
  });

  return router;
}
