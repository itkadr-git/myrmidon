// server/src/myrmidon/prompt-budget-advice/source.ts
//
// myrmidon(1.6.3 PROMPT-BUDGET C): where the advice reads the last run from.
//
// The generator is pure; this file is the port it depends on and the database
// adapter behind it. `loadLastRun` returns exactly the `lastRun` object of the
// prompt-budget status contract of the same release
// (`{ runId, total, parts }`), so the wiring can be repointed at that status
// service once it is merged without touching the generator or the routes.
//
// The read is a best-effort scan of an agent's recent runs for the first one
// that carries a breakdown: `usageJson.promptBreakdown` when the gateway
// recorded it, else the recorded input-token total without parts (a run that
// did not go through the gateway still yields a total, so it can be warned
// about). No new table and no migration: the breakdown lives in the existing
// `heartbeat_runs.usage_json` column.

import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";

/** How many recent runs are scanned for a usable breakdown. */
export const PROMPT_BUDGET_ADVICE_SCAN_LIMIT = 20;

/** One run's prompt breakdown. `parts` may be empty when only a total exists. */
export interface PromptRunBreakdown {
  runId: string | null;
  total: number;
  parts: Record<string, number>;
}

/** The agent the advice is about (and the optimizer agent, checked the same way). */
export interface PromptBudgetAgentRef {
  agentId: string;
  name: string;
  /** The model on the agent card, when one is configured. */
  model: string | null;
}

/** The port the routes depend on. Tests supply an in-memory implementation. */
export interface PromptBudgetAdviceSource {
  /** The agent row of this company, or null when the id is not one of its agents. */
  loadAgent(companyId: string, agentId: string): Promise<PromptBudgetAgentRef | null>;
  /** The agent's last run with a prompt breakdown, or null when there is none. */
  loadLastRun(companyId: string, agentId: string): Promise<PromptRunBreakdown | null>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.round(value);
  return null;
}

/**
 * Read a stored `usageJson` into a breakdown, or null when it carries neither a
 * breakdown nor an input-token total. A recorded breakdown wins; a missing one
 * falls back to the input total with no parts.
 */
export function parsePromptBreakdown(
  usageJson: unknown,
): { total: number; parts: Record<string, number> } | null {
  const usage = asRecord(usageJson);
  if (!usage) return null;

  const parts: Record<string, number> = {};
  const breakdown = asRecord(usage.promptBreakdown);
  if (breakdown) {
    const rawParts = asRecord(breakdown.parts);
    if (rawParts) {
      for (const [key, value] of Object.entries(rawParts)) {
        const tokens = numberOrNull(value);
        if (tokens !== null && tokens > 0) parts[key] = tokens;
      }
    }
    const total = numberOrNull(breakdown.total);
    if (total !== null) return { total, parts };
  }

  const fallback = numberOrNull(usage.inputTokens) ?? numberOrNull(usage.rawInputTokens);
  if (fallback !== null) return { total: fallback, parts };
  return null;
}

/** The database-backed source used in production. */
export function createDbPromptBudgetAdviceSource(db: Db): PromptBudgetAdviceSource {
  return {
    async loadAgent(companyId, agentId) {
      const [row] = await db
        .select({ id: agents.id, name: agents.name, adapterConfig: agents.adapterConfig })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)))
        .limit(1);
      if (!row) return null;
      const config = asRecord(row.adapterConfig);
      const model =
        typeof config?.model === "string" && config.model.trim() ? config.model.trim() : null;
      return { agentId: row.id, name: row.name, model };
    },

    async loadLastRun(companyId, agentId) {
      const rows = await db
        .select({ id: heartbeatRuns.id, usageJson: heartbeatRuns.usageJson })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)))
        .orderBy(desc(sql`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.startedAt})`))
        .limit(PROMPT_BUDGET_ADVICE_SCAN_LIMIT);
      for (const row of rows) {
        const parsed = parsePromptBreakdown(row.usageJson);
        if (parsed) return { runId: row.id, total: parsed.total, parts: parsed.parts };
      }
      return null;
    },
  };
}