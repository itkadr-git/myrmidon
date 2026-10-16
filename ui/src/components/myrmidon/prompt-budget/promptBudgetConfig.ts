// myrmidon(1.6.3 PROMPT-BUDGET B): pure helpers for the prompt-budget settings
// panel and the agent badge. No React, no network — unit-testable as is.
//
// The UI never invents policy — the sanity bounds below only keep a typo from
// saving an absurd number; the server validates the same range anyway.

import type { PromptBudgetLevel, PromptBudgetRunStatus } from "./promptBudgetApi";

/** UI sanity bounds, mirroring the server's schema. */
export const PROMPT_PCT_MIN = 1;
export const PROMPT_PCT_MAX = 100;
export const FALLBACK_WINDOW_MIN = 1000;

export type PromptBudgetParse =
  | { ok: true; value: number }
  | { ok: false; message: string };

/** A percent input: a whole number in 1..100. */
export function parsePromptPct(text: string): PromptBudgetParse {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, message: "Enter a whole number of percent." };
  }
  const value = Number(trimmed);
  if (value < PROMPT_PCT_MIN || value > PROMPT_PCT_MAX) {
    return {
      ok: false,
      message: `Enter a whole number from ${PROMPT_PCT_MIN} to ${PROMPT_PCT_MAX}.`,
    };
  }
  return { ok: true, value };
}

/** A fallback-window input: a whole number of tokens, at least 1000. */
export function parseFallbackWindow(text: string): PromptBudgetParse {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, message: "Enter a whole number of tokens." };
  }
  const value = Number(trimmed);
  if (value < FALLBACK_WINDOW_MIN) {
    return { ok: false, message: `Enter at least ${FALLBACK_WINDOW_MIN} tokens.` };
  }
  return { ok: true, value };
}

/** Draft text for an input. */
export function numberToText(value: number | null | undefined): string {
  return typeof value === "number" ? String(value) : "";
}

/** The badge label: the prompt share of the last run, e.g. "95%". */
export function promptBudgetBadgeText(run: PromptBudgetRunStatus): string {
  return `${run.pct}%`;
}

/** The badge tooltip: the share, the totals and the top parts. */
export function promptBudgetBadgeTitle(run: PromptBudgetRunStatus, windowTokens: number): string {
  const top = topParts(run.parts, 3);
  const partsText =
    top.length > 0 ? ` — biggest: ${top.map((p) => `${p.name} ${p.tokens}`).join(", ")}` : "";
  return `Last run prompt: ${run.pct}% of the window (${run.total}/${windowTokens} tokens)${partsText}`;
}

/** The top prompt parts by tokens (stable order). */
export function topParts(
  parts: Record<string, number>,
  limit = 3,
): Array<{ name: string; tokens: number }> {
  return Object.entries(parts)
    .map(([name, tokens]) => ({ name, tokens }))
    .sort((left, right) => right.tokens - left.tokens || left.name.localeCompare(right.name))
    .slice(0, limit);
}

/** The badge tone of a level. */
export function promptBudgetLevelTone(level: PromptBudgetLevel): "ok" | "warn" | "crit" {
  return level;
}
