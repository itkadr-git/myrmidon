// server/src/myrmidon/prompt-budget/sweep.ts
//
// myrmidon(1.6.3 PROMPT-BUDGET B): the periodic prompt-budget check.
// myrmidon(1.6.5 PROMPT-BUDGET-SIGNAL): the pass records the attention
// signals instead of writing comments into agent tasks.
//
// One pass per interval per company: read the settings (a disabled feature
// skips the pass before any query and clears the recorded signals), compute
// the live status, refresh the recorded signals — one per agent per UTC day,
// deduped on `prompt-budget:<agentId>:<utc day>` — and leave the surfaces to
// the attention feed, which recomputes on every list. An agent back under the
// warn threshold loses its record, so its card leaves the feed on the next
// list. No comment is written anywhere; the agent whose prompt is over budget
// is never woken by this signal.
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
import { buildPromptBudgetAttentionCards } from "./attention.js";
import {
  refreshPromptBudgetSignals,
  resetPromptBudgetSignals,
} from "./signal.js";

export const DEFAULT_PROMPT_BUDGET_SWEEP_INTERVAL_SEC = 300;
export const MIN_PROMPT_BUDGET_SWEEP_INTERVAL_SEC = 30;
export const MAX_PROMPT_BUDGET_SWEEP_INTERVAL_SEC = 3600;

export interface PromptBudgetSweepResult {
  /** True when the pass was skipped before scanning (interval gate). */
  skipped: boolean;
  inspected: number;
  /** New signals recorded by this pass — at most one per agent per UTC day. */
  signaled: number;
  /** Cards whose signal of the day was already recorded (dedup hits). */
  held: number;
  failed: number;
}

export interface PromptBudgetSweeperDeps {
  db: Db;
  settings: PromptBudgetSettingsService;
  intervalMs?: number;
  now?(): Date;
  log?: Pick<Logger, "info" | "warn">;
  /** Test seam: the live status reader (the real one hits the database). */
  readStatus?: typeof buildPromptBudgetStatus;
}

export interface PromptBudgetSweeper {
  resetForTest(): void;
  sweep(now?: Date, options?: { force?: boolean }): Promise<PromptBudgetSweepResult>;
}

export function createPromptBudgetSweeper(deps: PromptBudgetSweeperDeps): PromptBudgetSweeper {
  const intervalMs = deps.intervalMs ?? DEFAULT_PROMPT_BUDGET_SWEEP_INTERVAL_SEC * 1000;
  const log = deps.log ?? logger;
  const readStatus = deps.readStatus ?? buildPromptBudgetStatus;
  let lastSweepAtMs = 0;

  async function sweepCompany(companyId: string, result: PromptBudgetSweepResult): Promise<void> {
    // The settings gate: a disabled feature never signals. The read happens on
    // every pass, so a PUT of new thresholds applies on the next tick without
    // a restart.
    const settings = await readPromptBudgetSettings(deps.settings);
    if (!settings.enabled) {
      resetPromptBudgetSignals();
      return;
    }
    const statuses = await readStatus(deps.db, companyId, settings);
    const overThreshold = statuses.filter(
      (status) => status.lastRun !== null && status.lastRun.level !== "ok",
    );
    result.inspected += statuses.length;
    if (overThreshold.length === 0) {
      // Nothing over a threshold: every record of the company goes, so no
      // stale card survives the pass that says the state is over.
      refreshPromptBudgetSignals(companyId, [], deps.now?.() ?? new Date());
      return;
    }
    const nameRows = await deps.db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(eq(agents.companyId, companyId));
    const nameById = new Map<string, string>();
    for (const row of nameRows as Array<{ id: string; name: string }>) {
      nameById.set(row.id, row.name);
    }
    const refresh = refreshPromptBudgetSignals(
      companyId,
      buildPromptBudgetAttentionCards(overThreshold, nameById),
      deps.now?.() ?? new Date(),
    );
    result.signaled += refresh.recorded;
    result.held += refresh.held;
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
        held: 0,
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
