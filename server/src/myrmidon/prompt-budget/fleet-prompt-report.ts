// server/src/myrmidon/prompt-budget/fleet-prompt-report.ts
//
// myrmidon(1.6.3 PROMPT-BUDGET D): the fleet prompt report.
//
// The costs screen already ranks agents by spend. This module adds the prompt
// side of the same per-agent rows: the average prompt size of one run (tokens)
// and the share of runs whose prompt crossed the configured budget threshold.
// It is a report over existing data — no new table, no new store, no change to
// the columns that already exist.
//
// Data sources:
//   - `heartbeat_runs.usageJson.promptBreakdown.total` — the prompt size a run
//     recorded for itself (sibling part A, frozen contract
//     `{ parts: Record<string, number>, total: number }`). A run without a
//     breakdown is counted by the input tokens of its own cost events.
//   - `instance_settings.general.promptBudget` — the threshold settings of the
//     frozen inter-part contract (sibling part B):
//     `{ enabled, warnPct, critPct, ... }`. `warnPct`/`critPct` are percentages
//     of the agent model context window, so the absolute per-run threshold
//     needs the window of the model that served the run; that window is read
//     from the gateway model list (`litellm_models.maxInputTokens`). A run
//     whose model window is unknown cannot be judged against a percentage
//     threshold: it still counts towards the average prompt size and is left
//     out of the share (otherwise the share would silently drop to zero).
//   - `litellm_models` — the gateway model list, latest-seen row per model.
//
// Part B owns the shared schema `packages/shared/src/myrmidon-prompt-budget.ts`
// and the `promptBudget` key of the general settings schema. Until that lands,
// this module carries a local mirror of the contract and reads the stored
// `instance_settings.general` JSON directly: the general-settings normalizer
// keeps only the keys its schema knows, so a getter read would drop the key
// while part B is unmerged. Once part B merges, this read keeps working
// unchanged — it reads the same stored key.

import { and, eq, gte, isNotNull, lte, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { costEvents, heartbeatRuns, instanceSettings, litellmModels } from "@paperclipai/db";

/** Stored key of the threshold settings inside `instance_settings.general`. */
export const PROMPT_BUDGET_SETTINGS_KEY = "promptBudget";

/**
 * Local mirror of the frozen inter-part contract `general.promptBudget`
 * (sibling part B). `warnPct` and `critPct` are percentages of the agent model
 * context window; the report judges a run against `warnPct`.
 */
export interface PromptBudgetSettings {
  enabled: boolean;
  warnPct: number;
  critPct: number;
}

/** The two additive per-agent columns of the fleet report. */
export interface AgentPromptStats {
  /** Average prompt size of one run, in tokens; null when no run has data. */
  avgPromptTokens: number | null;
  /** Share of judged runs above the threshold, in percent; null when unknown. */
  runsAboveThresholdPct: number | null;
}

/** One run as the aggregator sees it (already resolved per run). */
export interface PromptRunInput {
  agentId: string;
  runId: string;
  /** Prompt size of the run, in tokens. */
  promptTokens: number;
  /** Model that served the run, when the run recorded one. */
  model: string | null;
}

export interface PromptReportRange {
  from?: Date;
  to?: Date;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Read the threshold settings of the frozen contract. An absent, disabled or
 * unusable object yields null: the report then leaves the share column empty
 * instead of inventing a threshold.
 */
export function normalizePromptBudgetSettings(value: unknown): PromptBudgetSettings | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.enabled === false) return null;
  const warnPct = asFiniteNumber(record.warnPct);
  if (warnPct === null || warnPct <= 0) return null;
  const critPct = asFiniteNumber(record.critPct);
  return {
    enabled: record.enabled !== false,
    warnPct,
    critPct: critPct !== null && critPct > 0 ? critPct : warnPct,
  };
}

/**
 * Prompt size of one run: the breakdown total the run recorded, or the input
 * tokens of its own cost events when the run has no breakdown. A total that is
 * not a finite number does not count as a breakdown.
 */
export function extractPromptTokens(usageJson: unknown, fallbackInputTokens: number | null): number | null {
  if (typeof usageJson === "object" && usageJson !== null && !Array.isArray(usageJson)) {
    const breakdown = (usageJson as Record<string, unknown>).promptBreakdown;
    if (typeof breakdown === "object" && breakdown !== null && !Array.isArray(breakdown)) {
      const total = asFiniteNumber((breakdown as Record<string, unknown>).total);
      if (total !== null && total >= 0) return total;
    }
  }
  if (fallbackInputTokens !== null && Number.isFinite(fallbackInputTokens) && fallbackInputTokens >= 0) {
    return fallbackInputTokens;
  }
  return null;
}

/**
 * Absolute prompt-token threshold of one run: `warnPct` percent of the window
 * of the model that served the run. Null when there is no usable setting or no
 * known window — such a run cannot be judged.
 */
export function promptThresholdTokens(
  settings: PromptBudgetSettings | null,
  modelWindowTokens: number | null,
): number | null {
  if (!settings) return null;
  if (modelWindowTokens === null || !Number.isFinite(modelWindowTokens) || modelWindowTokens <= 0) return null;
  return (settings.warnPct / 100) * modelWindowTokens;
}

function roundTo1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Fold per-run prompt sizes into the per-agent report columns. Runs are counted
 * once each; a run with no prompt data is skipped entirely.
 */
export function aggregateAgentPromptStats(
  runs: readonly PromptRunInput[],
  settings: PromptBudgetSettings | null,
  modelWindowTokens: ReadonlyMap<string, number> = new Map(),
): Map<string, AgentPromptStats> {
  interface Bucket {
    sum: number;
    count: number;
    judged: number;
    above: number;
  }
  const buckets = new Map<string, { bucket: Bucket; seenRuns: Set<string> }>();

  for (const run of runs) {
    if (!Number.isFinite(run.promptTokens) || run.promptTokens < 0) continue;
    let entry = buckets.get(run.agentId);
    if (!entry) {
      entry = { bucket: { sum: 0, count: 0, judged: 0, above: 0 }, seenRuns: new Set<string>() };
      buckets.set(run.agentId, entry);
    }
    if (entry.seenRuns.has(run.runId)) continue;
    entry.seenRuns.add(run.runId);

    const { bucket } = entry;
    bucket.sum += run.promptTokens;
    bucket.count += 1;

    const window = run.model ? modelWindowTokens.get(run.model) ?? null : null;
    const threshold = promptThresholdTokens(settings, window);
    if (threshold === null) continue;
    bucket.judged += 1;
    if (run.promptTokens > threshold) bucket.above += 1;
  }

  const stats = new Map<string, AgentPromptStats>();
  for (const [agentId, entry] of buckets) {
    const { bucket } = entry;
    stats.set(agentId, {
      avgPromptTokens: bucket.count > 0 ? Math.round(bucket.sum / bucket.count) : null,
      runsAboveThresholdPct: bucket.judged > 0 ? roundTo1((bucket.above / bucket.judged) * 100) : null,
    });
  }
  return stats;
}

/**
 * Threshold settings as stored in `instance_settings.general.promptBudget`.
 * The stored JSON is read directly (see the module header): while part B is
 * unmerged the settings normalizer does not know the key, and a getter read
 * would drop it.
 */
export async function readPromptBudgetSettings(db: Db): Promise<PromptBudgetSettings | null> {
  const [row] = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .limit(1);
  const general = row?.general;
  if (typeof general !== "object" || general === null) return null;
  return normalizePromptBudgetSettings((general as Record<string, unknown>)[PROMPT_BUDGET_SETTINGS_KEY]);
}

/** Latest-seen input window of every model the gateway has reported. */
export async function loadModelWindowTokens(db: Db): Promise<Map<string, number>> {
  const rows = await db
    .select({
      modelName: litellmModels.modelName,
      maxInputTokens: sql<number | null>`max(${litellmModels.maxInputTokens})`,
    })
    .from(litellmModels)
    .groupBy(litellmModels.modelName);

  const windows = new Map<string, number>();
  for (const row of rows) {
    const value = asFiniteNumber(row.maxInputTokens);
    if (value !== null && value > 0) windows.set(row.modelName, value);
  }
  return windows;
}

/**
 * One row per run that has cost events in the company (optionally inside the
 * range): the prompt size the run recorded, or the input tokens of the run.
 */
export async function loadPromptRunInputs(
  db: Db,
  companyId: string,
  range?: PromptReportRange,
): Promise<PromptRunInput[]> {
  const runEvents = alias(costEvents, "prompt_run_events");
  const conditions: SQL[] = [
    eq(runEvents.companyId, companyId),
    isNotNull(runEvents.heartbeatRunId),
  ];
  if (range?.from) conditions.push(gte(runEvents.occurredAt, range.from));
  if (range?.to) conditions.push(lte(runEvents.occurredAt, range.to));

  const rows = await db
    .select({
      agentId: runEvents.agentId,
      runId: runEvents.heartbeatRunId,
      model: sql<string | null>`min(${runEvents.model})`,
      runInputTokens: sql<number>`coalesce(sum(${runEvents.inputTokens}), 0)::double precision`,
      usageJson: heartbeatRuns.usageJson,
    })
    .from(runEvents)
    .leftJoin(heartbeatRuns, eq(heartbeatRuns.id, runEvents.heartbeatRunId))
    .where(and(...conditions))
    .groupBy(runEvents.agentId, runEvents.heartbeatRunId, heartbeatRuns.usageJson);

  const inputs: PromptRunInput[] = [];
  for (const row of rows) {
    if (!row.runId) continue;
    const promptTokens = extractPromptTokens(row.usageJson, asFiniteNumber(row.runInputTokens));
    if (promptTokens === null) continue;
    inputs.push({
      agentId: row.agentId,
      runId: row.runId,
      promptTokens,
      model: row.model ?? null,
    });
  }
  return inputs;
}

/** Per-agent fleet prompt columns for one company. */
export async function agentPromptStats(
  db: Db,
  companyId: string,
  range?: PromptReportRange,
): Promise<Map<string, AgentPromptStats>> {
  const [runs, modelWindowTokens, settings] = await Promise.all([
    loadPromptRunInputs(db, companyId, range),
    loadModelWindowTokens(db),
    readPromptBudgetSettings(db),
  ]);
  return aggregateAgentPromptStats(runs, settings, modelWindowTokens);
}