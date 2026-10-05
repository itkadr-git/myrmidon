// server/src/myrmidon/prompt-budget-advice/routes.ts
//
// myrmidon(1.6.3 PROMPT-BUDGET C): the advice API.
//
// - GET  /api/myrmidon/companies/:companyId/prompt-budget/agents/:agentId/advice
//        the static recommendations for the agent's last recorded run.
// - POST /api/myrmidon/companies/:companyId/prompt-budget/agents/:agentId/advice/deep
//        files a deep-analysis task for the configured optimizer agent and
//        answers with the link to it.
//
// Reads follow the company-access rule the other company-scoped myrmidon
// surfaces use; the deep POST is an operator action, so it requires board
// access to the company. The endpoint paths sit under the prompt-budget prefix
// of the same release but carry their own `/agents/:agentId/advice` tail, so
// they never touch the settings/status routes of the thresholds part.
//
// The three dependencies are injectable: tests drive the routes with in-memory
// fakes and no database, the same way the access-hub routes are tested.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { notFound, unprocessable } from "../../errors.js";
import { assertBoardOrgAccess, assertCompanyAccess } from "../../routes/authz.js";
import { issueService } from "../../services/issues.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { buildPromptBudgetAdvice } from "./advice.js";
import { buildDeepAnalysisTask, type DeepAnalysisTask } from "./deep.js";
import {
  readPromptBudgetOptimizerAgentId,
  type PromptBudgetSettingsService,
} from "./settings.js";
import { createDbPromptBudgetAdviceSource, type PromptBudgetAdviceSource } from "./source.js";

/** The task row an issue creator returns once a deep task exists. */
export interface CreatedDeepAnalysisTask {
  id: string;
  /** The human-facing identifier; the column is nullable, so the response is too. */
  identifier: string | null;
  title: string;
}

/** Everything the routes need; each entry has a production default. */
export interface PromptBudgetAdviceDeps {
  source: PromptBudgetAdviceSource;
  settings: PromptBudgetSettingsService;
  createTask: (companyId: string, task: DeepAnalysisTask) => Promise<CreatedDeepAnalysisTask>;
}

function defaultDeps(db: Db): PromptBudgetAdviceDeps {
  return {
    source: createDbPromptBudgetAdviceSource(db),
    settings: instanceSettingsService(db),
    createTask: async (companyId, task) => {
      const issue = await issueService(db).create(companyId, task);
      return { id: issue.id, identifier: issue.identifier, title: issue.title };
    },
  };
}

export function promptBudgetAdviceRoutes(
  db: Db,
  overrides: Partial<PromptBudgetAdviceDeps> = {},
) {
  const deps: PromptBudgetAdviceDeps = { ...defaultDeps(db), ...overrides };
  const router = Router();

  router.get(
    "/myrmidon/companies/:companyId/prompt-budget/agents/:agentId/advice",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const agentId = req.params.agentId as string;

      const agent = await deps.source.loadAgent(companyId, agentId);
      if (!agent) throw notFound("Agent not found");

      const run = await deps.source.loadLastRun(companyId, agentId);
      const advice = buildPromptBudgetAdvice({ agentId, run });
      res.json({ ...advice, agentName: agent.name, model: agent.model });
    },
  );

  router.post(
    "/myrmidon/companies/:companyId/prompt-budget/agents/:agentId/advice/deep",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoardOrgAccess(req);
      const agentId = req.params.agentId as string;

      const target = await deps.source.loadAgent(companyId, agentId);
      if (!target) throw notFound("Agent not found");

      const optimizerAgentId = await readPromptBudgetOptimizerAgentId(deps.settings);
      if (!optimizerAgentId) {
        throw unprocessable(
          "No prompt-budget optimizer agent is configured. Set promptBudget.optimizerAgentId in the instance general settings.",
        );
      }
      if (optimizerAgentId === target.agentId) {
        throw unprocessable(
          "The configured prompt-budget optimizer agent is the analysed agent itself; configure a different agent.",
        );
      }
      if (!(await deps.source.loadAgent(companyId, optimizerAgentId))) {
        throw unprocessable(
          "The configured prompt-budget optimizer agent is not an agent of this company.",
        );
      }

      const run = await deps.source.loadLastRun(companyId, agentId);
      if (!run) {
        throw unprocessable("This agent has no recorded run with a prompt breakdown to analyse.");
      }

      const advice = buildPromptBudgetAdvice({ agentId, run });
      const task = buildDeepAnalysisTask({ target, run, advice, optimizerAgentId });
      const created = await deps.createTask(companyId, task);

      res.status(201).json({
        issueId: created.id,
        identifier: created.identifier,
        title: created.title,
      });
    },
  );

  return router;
}