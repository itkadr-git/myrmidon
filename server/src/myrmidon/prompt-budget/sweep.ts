// server/src/myrmidon/prompt-budget/sweep.ts
//
// myrmidon(1.6.3 PROMPT-BUDGET B): the periodic prompt-budget check.
//
// One pass per interval per company: read the settings (a disabled feature
// skips the pass before any query), compute the live status, deliver one
// deduped signal comment per agent whose last run crossed a threshold. The
// attention feed needs no sweep of its own — it recomputes on every list.
//
// The interval is in-module (the same shape the wip-limit sweep uses); a pass
// whose previous run is still going is skipped, not queued.

import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies } from "@paperclipai/db";
import type { Logger } from "pino";
import { logger } from "../../middleware/logger.js";
import { readPromptBudgetSettings, type PromptBudgetSettingsService } from "./settings.js";
import { buildPromptBudgetStatus } from "./status.js";
import { deliverPromptBudgetSignal, type PromptBudgetSignalPorts } from "./signal.js";

export const DEFAULT_PROMPT_BUDGET_SWEEP_INTERVAL_SEC = 300;
export const MIN_PROMPT_BUDGET_SWEEP_INTERVAL_SEC = 30;
export const MAX_PROMPT_BUDGET_SWEEP_INTERVAL_SEC = 3600;

export interface PromptBudgetSweepResult {
  /** True when the pass was skipped before scanning (interval gate). */
  skipped: boolean;
  inspected: number;
  signaled: number;
  failed: number;
}

export interface PromptBudgetSweeperDeps {
  db: Db;
  settings: PromptBudgetSettingsService;
  addComment: PromptBudgetSignalPorts["addComment"];
  intervalMs?: number;
  now?(): Date;
  log?: Pick<Logger, "info" | "warn">;
}

export interface PromptBudgetSweeper {
  resetForTest(): void;
  sweep(now?: Date, options?: { force?: boolean }): Promise<PromptBudgetSweepResult>;
}

export function createPromptBudgetSweeper(deps: PromptBudgetSweeperDeps): PromptBudgetSweeper {
  const intervalMs = deps.intervalMs ?? DEFAULT_PROMPT_BUDGET_SWEEP_INTERVAL_SEC * 1000;
  const log = deps.log ?? logger;
  let lastSweepAtMs = 0;

  async function sweepCompany(companyId: string, result: PromptBudgetSweepResult): Promise<void> {
    // The settings gate: a disabled feature never signals. The read happens on
    // every pass, so a PUT of new thresholds applies on the next tick without
    // a restart.
    const settings = await readPromptBudgetSettings(deps.settings);
    if (!settings.enabled) return;
    const statuses = await buildPromptBudgetStatus(deps.db, companyId, settings);
    const overThreshold = statuses.filter(
      (status) => status.lastRun !== null && status.lastRun.level !== "ok",
    );
    result.inspected += statuses.length;
    if (overThreshold.length === 0) return;
    const nameRows = await deps.db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(eq(agents.companyId, companyId));
    const nameById = new Map(nameRows.map((row) => [row.id, row.name] as const));
    for (const status of overThreshold) {
      const outcome = await deliverPromptBudgetSignal(
        deps.db,
        { addComment: deps.addComment, now: deps.now ?? (() => new Date()) },
        { companyId, status, agentName: nameById.get(status.agentId) ?? null },
      );
      if (outcome.written) result.signaled += 1;
    }
  }

  return {
    resetForTest() {
      lastSweepAtMs = 0;
    },
    async sweep(now = new Date(), options) {
      const result: PromptBudgetSweepResult = {
        skipped: false,
        inspected: 0,
        signaled: 0,
        failed: 0,
      };
      if (!options?.force && now.getTime() - lastSweepAtMs < intervalMs) {
        result.skipped = true;
        return result;
      }
      lastSweepAtMs = now.getTime();

      const companyRows = await deps.db
        .select({ id: companies.id })
        .from(companies)
        .where(and(eq(companies.status, "active")));
      for (const company of companyRows) {
        try {
          await sweepCompany(company.id, result);
        } catch (err) {
          result.failed += 1;
          log.warn({ err, companyId: company.id }, "Prompt budget sweep failed for one company");
        }
      }
      if (result.signaled > 0 || result.failed > 0) {
        log.info(result, "Prompt budget sweep completed");
      }
      return result;
    },
  };
}
