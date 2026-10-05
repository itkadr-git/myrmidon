// adapter-utils/src/prompt-meter.ts
//
// myrmidon(1.6.5 PROMPT-BUDGET A): cheap client-side prompt-size accounting.
//
// Every run records the size of the prompt it assembled, broken down by
// section, into `heartbeat_runs.usageJson.promptBreakdown`
// (`{ parts: Record<string, number>, total: number }` — the frozen inter-part
// contract; sibling parts B/D read `promptBreakdown.total`, see
// server/src/myrmidon/prompt-budget/fleet-prompt-report.ts). The point is
// budget observability, not billing precision, so the estimate is the
// chars/4 heuristic: dependency-free, deterministic, and within ~10-20% of a
// real BPE count for the English/markdown/JSON mix these prompts carry.
// Tokenizers differ per provider anyway; the breakdown answers "which part
// of the prompt is big", which a heuristic answers fine.
//
// No new dependencies: keep it that way unless a measured accuracy problem
// justifies a tokenizer (record license + reason in the PR that adds one).

/** Heuristic characters-per-token ratio for prose/markdown/JSON prompts. */
export const PROMPT_METER_CHARS_PER_TOKEN = 4;

/**
 * Cheap token estimate for a prompt section: ceil(chars / 4). Empty or
 * non-string input estimates to 0. Deterministic and locale-independent.
 */
export function estimateTokens(text: string | null | undefined): number {
  if (typeof text !== "string" || text.length === 0) return 0;
  return Math.ceil(text.length / PROMPT_METER_CHARS_PER_TOKEN);
}

/**
 * Token breakdown of one assembled prompt: per-part estimates plus total.
 * Frozen inter-part contract: persisted into
 * `heartbeat_runs.usageJson.promptBreakdown`; sibling prompt-budget parts
 * (fleet report, budget advice) read `total`.
 */
export interface PromptBreakdown {
  parts: Record<string, number>;
  total: number;
}

/**
 * Measure a named set of prompt sections. Empty/blank sections are omitted
 * from `parts`; `total` is always the exact sum of the listed parts, so
 * consumers can reconcile `total` against `parts` without re-estimating.
 */
export function measureSections(
  sections: Record<string, string | null | undefined>,
): PromptBreakdown {
  const parts: Record<string, number> = {};
  let total = 0;
  for (const [name, text] of Object.entries(sections)) {
    const tokens = estimateTokens(text);
    if (tokens <= 0) continue;
    parts[name] = tokens;
    total += tokens;
  }
  return { parts, total };
}
