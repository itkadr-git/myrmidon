// packages/shared/src/myrmidon-prompt-budget.ts
//
// myrmidon(1.6.3 PROMPT-BUDGET B): the shared contract of prompt-budget
// thresholds — the warn/crit percentages of an agent's model context window
// that raise a signal (attention feed + agent card) when a run's prompt
// crosses them.
//
// The settings live in `instance_settings.general.promptBudget` and change
// live (no restart): the sweep and the status route re-read them on every
// pass. The shape is additive-only across the parts of this release:
//
//   - warnPct / critPct / enabled belong to the thresholds part;
//   - fallbackWindowTokens is the documented constant the brief asks for:
//     when the agent's model is unknown to `litellm_models` (no
//     `maxInputTokens` seen), the percentages count against this window
//     instead. The fleet report of the same release reads the same key, so
//     a run of an unknown model still lands in the "over threshold" share;
//   - optimizerAgentId names the agent the "Deep analysis" button of the
//     advice part tasks; the advice part only reads it, the settings panel
//     here writes it.
//
// The stored row is the single truth — an absent or malformed row normalizes
// to the defaults (warn 70, crit 90, enabled, 200k fallback window), so a
// hand-edited row can never half-apply.

import { z } from "zod";

/** The `instance_settings.general` key this feature stores its settings under. */
export const PROMPT_BUDGET_SETTINGS_KEY = "promptBudget";

/** The default warn threshold, percent of the model's input window. */
export const PROMPT_BUDGET_DEFAULT_WARN_PCT = 70;

/** The default crit threshold, percent of the model's input window. */
export const PROMPT_BUDGET_DEFAULT_CRIT_PCT = 90;

/**
 * The window the percentages count against when the agent's model has no
 * known `maxInputTokens` (the model never passed the cost feed). 200k covers
 * the common long-context cards; an operator with smaller windows lowers it
 * on the settings panel.
 */
export const PROMPT_BUDGET_DEFAULT_FALLBACK_WINDOW_TOKENS = 200_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Body of `PUT .../prompt-budget/settings` — the full settings object. */
export const promptBudgetSettingsSchema = z
  .object({
    /** Warn level, percent of the model window (strictly below critPct). */
    warnPct: z.number().int().min(1).max(99),
    /** Crit level, percent of the model window (strictly above warnPct). */
    critPct: z.number().int().min(2).max(100),
    /** false = the feature reports the status but never raises a signal. */
    enabled: z.boolean(),
    /** The window used when the agent's model is unknown to litellm_models. */
    fallbackWindowTokens: z.number().int().min(1000).max(100_000_000),
    /** The agent the advice part's deep analysis is assigned to; null = not set. */
    optimizerAgentId: z
      .string()
      .regex(UUID_RE)
      .nullable()
      .default(null),
  })
  .strict()
  .refine((value) => value.critPct > value.warnPct, {
    message: "critPct must be greater than warnPct",
    path: ["critPct"],
  });

export type PromptBudgetSettings = z.infer<typeof promptBudgetSettingsSchema>;

/** The settings the feature runs on when nothing (usable) is stored. */
export function defaultPromptBudgetSettings(): PromptBudgetSettings {
  return {
    warnPct: PROMPT_BUDGET_DEFAULT_WARN_PCT,
    critPct: PROMPT_BUDGET_DEFAULT_CRIT_PCT,
    enabled: true,
    fallbackWindowTokens: PROMPT_BUDGET_DEFAULT_FALLBACK_WINDOW_TOKENS,
    optimizerAgentId: null,
  };
}

/** The settings as stored, or the defaults when absent or unreadable. */
export function normalizePromptBudgetSettings(raw: unknown): PromptBudgetSettings {
  const parsed = promptBudgetSettingsSchema.safeParse(raw);
  if (parsed.success) return { ...parsed.data };
  // A hand-edited row cannot half-apply: an unreadable object is the default
  // set, so the feature never signals off corrupt thresholds.
  return defaultPromptBudgetSettings();
}

// --- level -----------------------------------------------------------------

export type PromptBudgetLevel = "ok" | "warn" | "crit";

/**
 * The level of one run's prompt size against the settings. A disabled feature
 * never leaves "ok" — it still reports the numbers, it just never signals.
 */
export function promptBudgetLevel(
  settings: Pick<PromptBudgetSettings, "warnPct" | "critPct" | "enabled">,
  pct: number,
): PromptBudgetLevel {
  if (!settings.enabled) return "ok";
  if (pct >= settings.critPct) return "crit";
  if (pct >= settings.warnPct) return "warn";
  return "ok";
}

/** The share of the window a prompt total takes, in percent (one decimal). */
export function promptBudgetPct(total: number, windowTokens: number): number {
  if (windowTokens <= 0) return 0;
  return Math.round((total / windowTokens) * 1000) / 10;
}

// --- status feed ------------------------------------------------------------

/** One run's prompt footprint, as the status feed reports it. */
export interface PromptBudgetRunStatus {
  runId: string | null;
  total: number;
  /** Breakdown by prompt part; empty when the run only recorded a total. */
  parts: Record<string, number>;
  /** total / windowTokens, percent, one decimal. */
  pct: number;
  level: PromptBudgetLevel;
}

/** One row of `GET .../prompt-budget/status` — the live per-agent picture. */
export interface PromptBudgetAgentStatus {
  agentId: string;
  /** The model on the agent card; null when none is configured. */
  model: string | null;
  /** The window the percentages count against (model's, else the fallback). */
  windowTokens: number;
  /** True when windowTokens is the settings fallback (model unknown). */
  windowIsFallback: boolean;
  /** The agent's last run with a usable prompt size, or null. */
  lastRun: PromptBudgetRunStatus | null;
  settings: PromptBudgetSettings;
}

/**
 * Build the run-status half of an agent row. `total`/`parts` come from the
 * run's usageJson (see the advice part's parsePromptBreakdown); the window is
 * resolved by the caller.
 */
export function buildPromptBudgetRunStatus(input: {
  runId: string | null;
  total: number;
  parts: Record<string, number>;
  windowTokens: number;
  settings: PromptBudgetSettings;
}): PromptBudgetRunStatus {
  const pct = promptBudgetPct(input.total, input.windowTokens);
  return {
    runId: input.runId,
    total: input.total,
    parts: { ...input.parts },
    pct,
    level: promptBudgetLevel(input.settings, pct),
  };
}

/** The dedup key of a prompt-budget signal comment — one per agent per window. */
export function promptBudgetSignalKey(agentId: string, windowStart: Date): string {
  return `prompt-budget:${agentId}:${windowStart.toISOString().slice(0, 10)}`;
}

/** The attention-feed dedup key of one agent's prompt-budget card. */
export const PROMPT_BUDGET_ATTENTION_DEDUP_PREFIX = "prompt_budget";

/**
 * The top prompt parts by tokens, for the attention detail and the agent
 * card. Stable order: by tokens desc, then by name, so a re-render never
 * reshuffles equal parts.
 */
export function topPromptBudgetParts(
  parts: Record<string, number>,
  limit = 3,
): Array<{ name: string; tokens: number }> {
  return Object.entries(parts)
    .map(([name, tokens]) => ({ name, tokens }))
    .sort((left, right) => right.tokens - left.tokens || left.name.localeCompare(right.name))
    .slice(0, limit);
}
