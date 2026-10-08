// server/src/myrmidon/prompt-budget/routes.ts
//
// myrmidon(1.6.3 PROMPT-BUDGET B): the settings and status API.
//
// - GET/PUT /api/myrmidon/companies/:companyId/prompt-budget/settings — the
//   settings object `{ warnPct, critPct, enabled, fallbackWindowTokens,
//   optimizerAgentId }`. Any company member reads; instance admins write (the
//   same rule the other company-scoped myrmidon surfaces follow). A write
//   applies on the next sweep tick — no restart.
// - GET /api/myrmidon/companies/:companyId/prompt-budget/status —
//   `{ agents: [{ agentId, model, windowTokens, windowIsFallback, lastRun,
//   settings }] }`, computed on the fly. The shape is the frozen inter-part
//   contract: the advice part (deep analysis) and the fleet report read it.
//
// The contract is additive-only: fields are never renamed or removed.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { promptBudgetSettingsSchema, type PromptBudgetSettings } from "@paperclipai/shared";
import { validate } from "../../middleware/validate.js";
import { assertCompanyAccess, assertInstanceAdmin } from "../../routes/authz.js";
import { issueService } from "../../services/issues.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { readPromptBudgetSettings, writePromptBudgetSettings } from "./settings.js";
import { buildPromptBudgetStatus } from "./status.js";

export function promptBudgetRoutes(db: Db) {
  const router = Router();
  const settings = instanceSettingsService(db);

  router.get("/myrmidon/companies/:companyId/prompt-budget/settings", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await readPromptBudgetSettings(settings));
  });

  router.put(
    "/myrmidon/companies/:companyId/prompt-budget/settings",
    validate(promptBudgetSettingsSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertInstanceAdmin(req);
      res.json(await writePromptBudgetSettings(settings, req.body as PromptBudgetSettings));
    },
  );

  router.get("/myrmidon/companies/:companyId/prompt-budget/status", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const current = await readPromptBudgetSettings(settings);
    res.json({ agents: await buildPromptBudgetStatus(db, companyId, current) });
  });

  return router;
}

/** The sweep's comment port, bound to the issue service (index.ts uses this). */
export function promptBudgetAddCommentPort(db: Db) {
  const svc = issueService(db);
  return (
    issueId: string,
    body: string,
    options: Parameters<typeof svc.addComment>[3],
  ) =>
    svc.addComment(issueId, body, {}, {
      authorType: "system",
      presentation: options?.presentation,
      metadata: options?.metadata,
    });
}
