// server/src/myrmidon/foraging/routes.ts
//
// myrmidon(1.6-FORAGE): the FORAGING API.
//
//   GET    /api/myrmidon/companies/:companyId/foraging/sources        (company access)
//   PUT    /api/myrmidon/companies/:companyId/foraging/sources        (board)
//   DELETE /api/myrmidon/companies/:companyId/foraging/sources/:id    (board)
//   GET    /api/myrmidon/companies/:companyId/foraging/findings       (company access)
//   GET    /api/myrmidon/companies/:companyId/foraging/budget         (company access)
//   POST   /api/myrmidon/companies/:companyId/foraging/sweep          (board; spends a read)
//
// myrmidon(1.6.1-FORAGING-LIMITS-UI): the settings and the spend of the sweep.
//
//   GET    /api/myrmidon/foraging-settings        (board org access)
//   PATCH  /api/myrmidon/foraging-settings        (instance admin)
//   GET    /api/myrmidon/companies/:companyId/foraging/spend   (company access)
//
// The settings route follows the RUNTIME-LIMITS rule: any board member reads,
// instance-admin writes. The switch and the limits apply with the next pass —
// the service resolves the settings row on every run, no restart.
//
// Reads need company access; mutations need a board actor. The manual sweep
// additionally spends real external reads and is therefore board-only.
//
// While the sweep is switched off the reads still answer: the registry and the
// findings list are useful on their own, and the sweep trigger answers 503 with
// `enabled: false` so the screen can say why nothing runs.

import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { patchForagingSettingsSchema, type ForagingSettingsPatch } from "@paperclipai/shared";
import { validate } from "../../middleware/validate.js";
import {
  assertBoard,
  assertBoardOrgAccess,
  assertCompanyAccess,
  assertInstanceAdmin,
  getActorInfo,
} from "../../routes/authz.js";
import { logActivity } from "../../services/activity-log.js";
import { FORAGING_SOURCE_KINDS, type ForagingSourceKind } from "./domain.js";
import { readForagingSettings, type ForagingSettingsService } from "./settings.js";
import type { ForagingService } from "./service.js";
import type { ForagingSourceRow, ForagingStore } from "./store.js";

const upsertSourceSchema = z.object({
  role: z.string().min(1).max(64),
  url: z.string().url().max(2048),
  kind: z.enum(FORAGING_SOURCE_KINDS).default("url"),
  enabled: z.boolean().optional(),
});

export interface ForagingRoutesDeps {
  /** Only for the audit rows; reads and writes go through the store. */
  db: Db;
  store: ForagingStore;
  service: ForagingService;
  /** 1.6.1: the instance settings service of the sweep (GET/PATCH above). */
  settingsService?: ForagingSettingsService;
  env?: NodeJS.ProcessEnv;
}

function sourceView(row: ForagingSourceRow) {
  return {
    id: row.id,
    role: row.role,
    url: row.url,
    kind: row.kind,
    enabled: row.enabled,
    lastSnapshotAt: row.lastSnapshotAt,
    lastCheckedAt: row.lastCheckedAt,
    lastError: row.lastError,
    snapshotLines: row.lastSnapshot?.length ?? null,
  };
}

export function foragingRoutes(deps: ForagingRoutesDeps) {
  const router = Router();
  const base = "/myrmidon/companies/:companyId/foraging";
  const settings = () => readForagingSettings(deps.env ?? process.env);

  // myrmidon(1.6.1-FORAGING-LIMITS-UI): the settings screen reads the
  // effective settings and where each value came from; an instance admin
  // saves a patch that applies with the next pass.
  router.get("/myrmidon/foraging-settings", async (req, res) => {
    assertBoardOrgAccess(req);
    const resolved = await deps.settingsService?.read();
    if (!resolved) {
      // No settings service wired (unit tests): fall back to the env view.
      const envSettings = readForagingSettings(deps.env ?? process.env);
      res.json({
        settings: {
          enabled: envSettings.enabled,
          intervalSec: Math.round(envSettings.intervalMs / 1000),
          minHostIntervalSec: Math.round(envSettings.minHostIntervalMs / 1000),
          passBudgetCents: envSettings.budget.enabled ? envSettings.budget.maxCostCents : null,
          dailyBudgetCents: null,
          monthlyBudgetCents: null,
          roleBudgetCents: null,
          agentBudgetCents: null,
          enforcement: "hard",
          autoOffCostPerTaskCents: null,
        },
        sources: {},
      });
      return;
    }
    res.json(resolved);
  });

  router.patch(
    "/myrmidon/foraging-settings",
    validate(patchForagingSettingsSchema),
    async (req, res) => {
      assertInstanceAdmin(req);
      if (!deps.settingsService) {
        res.status(503).json({ error: "Foraging settings service is not available" });
        return;
      }
      const actor = getActorInfo(req);
      const resolved = await deps.settingsService.update(req.body as ForagingSettingsPatch, {
        actorType: actor.actorType,
        actorId: actor.actorId,
      });
      res.json(resolved);
    },
  );

  // myrmidon(1.6.1-FORAGING-LIMITS-UI): the spend the limits and Costs read.
  router.get(`${base}/spend`, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rawDays = typeof req.query.days === "string" ? Number(req.query.days) : NaN;
    const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.min(Math.floor(rawDays), 90) : 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const rows = await deps.store.spendBreakdown(companyId, since);
    const totalCents = rows.reduce((sum, row) => sum + row.costCents, 0);
    res.json({ rows, totalCents, days });
  });

  router.get(`${base}/sources`, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rows = await deps.store.listSources(companyId);
    res.json({ sources: rows.map(sourceView), enabled: settings().enabled });
  });

  router.put(`${base}/sources`, validate(upsertSourceSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const body = req.body as z.infer<typeof upsertSourceSchema>;
    const row = await deps.store.upsertSource(companyId, {
      role: body.role,
      url: body.url,
      kind: body.kind as ForagingSourceKind,
      enabled: body.enabled,
    });
    const actor = getActorInfo(req);
    await logActivity(deps.db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "myrmidon.foraging.source_saved",
      entityType: "foraging_source",
      entityId: row.id,
      details: { role: row.role, kind: row.kind, enabled: row.enabled },
    });
    res.json(sourceView(row));
  });

  router.delete(`${base}/sources/:sourceId`, async (req, res) => {
    const companyId = req.params.companyId as string;
    const sourceId = req.params.sourceId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const removed = await deps.store.deleteSource(companyId, sourceId);
    if (!removed) {
      res.status(404).json({ error: "Source not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(deps.db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "myrmidon.foraging.source_removed",
      entityType: "foraging_source",
      entityId: sourceId,
      details: {},
    });
    res.json({ removed: true });
  });

  router.get(`${base}/findings`, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : NaN;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 200) : 50;
    const rows = await deps.store.listFindings(companyId, limit);
    res.json({ findings: rows, enabled: settings().enabled });
  });

  router.get(`${base}/budget`, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const current = settings();
    const state = await deps.service.budgetState(companyId);
    res.json({
      enabled: current.enabled,
      budget: current.budget,
      spentCents: state.spentCents,
      minHostIntervalMs: current.minHostIntervalMs,
      intervalMs: current.intervalMs,
      // myrmidon(1.6.1-FORAGING-LIMITS-UI): the window spend and the ceilings.
      dayCents: state.dayCents,
      monthCents: state.monthCents,
      dailyBudgetCents: state.dailyBudgetCents,
      monthlyBudgetCents: state.monthlyBudgetCents,
    });
  });

  router.post(`${base}/sweep`, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    if (!settings().enabled) {
      res.status(503).json({ error: "Foraging is not enabled on this instance", enabled: false });
      return;
    }
    const result = await deps.service.runPass(companyId);
    const actor = getActorInfo(req);
    await logActivity(deps.db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "myrmidon.foraging.sweep_run",
      entityType: "company",
      entityId: companyId,
      details: { ...result },
    });
    res.json(result);
  });

  return router;
}