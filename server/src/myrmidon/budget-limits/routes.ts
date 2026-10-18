// server/src/myrmidon/budget-limits/routes.ts
//
// myrmidon(1.7-BUDGET-CONFIG A): the limits API.
//
//   GET    /api/myrmidon/companies/:companyId/budget-limits                 (company access)
//   GET    /api/myrmidon/companies/:companyId/budget-limits/usage           (company access)
//   GET    /api/myrmidon/companies/:companyId/budget-limits/journal         (company access)
//   GET    /api/myrmidon/companies/:companyId/budget-limits/signal-only     (company access)
//   PATCH  /api/myrmidon/companies/:companyId/budget-limits/signal-only     (board only)
//   PUT    /api/myrmidon/companies/:companyId/budget-limits/limits/:level/:ref  (board only)
//   GET    /api/myrmidon/companies/:companyId/budget-limits/limits/:level/:ref  (company access)
//   DELETE /api/myrmidon/companies/:companyId/budget-limits/limits/:level/:ref  (board only)
//
// Reads need company access; every mutation needs a board actor and writes an
// activity-log row. `usage` answers per-limit "spent in period" rows computed
// from the existing spend accounting (litellm_cost_events; foraging level —
// its own budget view).
//
// The signal-only flag is runtime-mutable (no restart); the GET answers the
// effective value AND its source (stored / env / default) so the screen can
// show where the value comes from — the env variable is a forced override.

import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import {
  BUDGET_LIMIT_LEVELS,
  budgetLimitUpsertSchema,
  budgetLimitsSignalOnlySchema,
  isBudgetLimitOver,
  type BudgetLimitLevel,
} from "@paperclipai/shared";
import { validate } from "../../middleware/validate.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "../../routes/authz.js";
import { logActivity } from "../../services/activity-log.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { createBudgetLimitStore, validateBudgetLimitRef } from "./store.js";
import { computeBudgetLimitUsage } from "./usage.js";
import { readResolvedSignalOnly, writeBudgetLimitsSignalOnly } from "./settings.js";

const levelSchema = z.enum(BUDGET_LIMIT_LEVELS);

function asLevel(value: string): BudgetLimitLevel | null {
  const parsed = levelSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export interface BudgetLimitRoutesDeps {
  /** The foraging budget view (per OPE-3964, absorbed by the foraging level). */
  foragingBudgetState?: (companyId: string) => Promise<{ spentCents: number }>;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export function budgetLimitsRoutes(db: Db, deps: BudgetLimitRoutesDeps = {}) {
  const router = Router();
  const store = createBudgetLimitStore({ db, now: deps.now });
  const settings = instanceSettingsService(db);
  const base = "/myrmidon/companies/:companyId/budget-limits";

  router.get(base, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const levelParam = typeof req.query.level === "string" ? asLevel(req.query.level) : undefined;
    res.json({ limits: await store.list(companyId, levelParam ?? undefined) });
  });

  router.get(`${base}/usage`, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const limits = await store.list(companyId);
    const rows = await Promise.all(
      limits.map(async (limit) => {
        const usage = await computeBudgetLimitUsage(
          { db, foragingBudgetState: deps.foragingBudgetState, now: deps.now },
          companyId,
          limit.level,
          limit.ref,
          limit.period,
        );
        return {
          ...limit,
          spentCents: usage.spentCents,
          events: usage.events,
          overLimit: isBudgetLimitOver(limit, usage.spentCents),
        };
      }),
    );
    res.json({ usage: rows });
  });

  router.get(`${base}/journal`, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const levelParam = typeof req.query.level === "string" ? asLevel(req.query.level) : undefined;
    const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
    const limit = rawLimit && Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 100;
    res.json({ journal: await store.journal(companyId, levelParam ?? undefined, limit) });
  });

  router.get(`${base}/signal-only`, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const resolved = await readResolvedSignalOnly(settings, deps.env ?? process.env);
    res.json(resolved);
  });

  router.patch(
    `${base}/signal-only`,
    validate(budgetLimitsSignalOnlySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertBoard(req);
      const body = req.body as z.infer<typeof budgetLimitsSignalOnlySchema>;
      const stored = await writeBudgetLimitsSignalOnly(settings, body.signalOnly);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "myrmidon.budget_limits.signal_only",
        entityType: "instance_settings",
        entityId: "budgetLimits",
        details: { signalOnly: stored.signalOnly },
      });
      const resolved = await readResolvedSignalOnly(settings, deps.env ?? process.env);
      res.json(resolved);
    },
  );

  router.get(`${base}/limits/:level/:ref`, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const level = asLevel(req.params.level as string);
    if (!level) {
      res.status(400).json({ error: `Unknown level '${req.params.level}'` });
      return;
    }
    const ref = req.params.ref as string;
    const limit = await store.get(companyId, level, ref);
    if (!limit) {
      res.status(404).json({ error: "Limit not found" });
      return;
    }
    res.json(limit);
  });

  router.put(
    `${base}/limits/:level/:ref`,
    validate(budgetLimitUpsertSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertBoard(req);
      const level = asLevel(req.params.level as string);
      if (!level) {
        res.status(400).json({ error: `Unknown level '${req.params.level}'` });
        return;
      }
      const ref = req.params.ref as string;
      const refError = validateBudgetLimitRef(level, ref);
      if (refError) {
        res.status(400).json({ error: refError });
        return;
      }
      const body = req.body as z.infer<typeof budgetLimitUpsertSchema>;
      const actorInfo = getActorInfo(req);
      const limit = await store.upsert(
        companyId,
        level,
        ref,
        {
          amountCents: body.amountCents,
          period: body.period,
          mode: body.mode,
          isActive: body.isActive,
        },
        {
          actorType: actorInfo.actorType,
          actorId: actorInfo.actorId,
          userId: actorInfo.actorType === "user" ? actorInfo.actorId : null,
        },
      );
      const actor = actorInfo;
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "myrmidon.budget_limits.limit_saved",
        entityType: "budget_limit",
        entityId: limit.id,
        details: { level, ref, amountCents: limit.amountCents, period: limit.period, mode: limit.mode },
      });
      res.json(limit);
    },
  );

  router.delete(`${base}/limits/:level/:ref`, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const level = asLevel(req.params.level as string);
    if (!level) {
      res.status(400).json({ error: `Unknown level '${req.params.level}'` });
      return;
    }
    const ref = req.params.ref as string;
    const removed = await store.remove(companyId, level, ref, {
      actorType: "user",
      actorId: getActorInfo(req).actorId,
    });
    if (!removed) {
      res.status(404).json({ error: "Limit not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "myrmidon.budget_limits.limit_deleted",
      entityType: "budget_limit",
      entityId: `${level}/${ref}`,
      details: { level, ref },
    });
    res.json({ removed: true });
  });

  return router;
}
