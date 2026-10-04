// myrmidon(1.6.3 PROMPT-BUDGET A): cheap prompt-size accounting per run.
// A real tokenizer (BPE) would need a new dependency; the chars/4 heuristic is
// the documented trade-off (see DIVERGENCE.md) — it is monotone in the text
// size and stable enough for breakdown comparisons across runs.

/**
 * Rough token estimate for a piece of prompt text.
 *
 * Heuristic: one token per ~4 characters of English/code text, rounded up.
 * Whitespace-only and empty strings are 0. Never throws on arbitrary input.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return Math.ceil(trimmed.length / 4);
}

export type PromptBreakdown = {
  /** Estimated tokens per named prompt section. Keys are the section names. */
  parts: Record<string, number>;
  /** Estimated tokens for the full prompt as actually sent. */
  total: number;
};

/**
 * Measure every section of a prompt and the prompt as a whole.
 *
 * `parts` covers exactly the keys of `sections` (in insertion order);
 * `total` is measured against `joined ?? Object.values(sections).join("\n")`,
 * i.e. the caller may pass the exact text it sends so the total accounts for
 * separators between sections instead of assuming a single "\n" join.
 */
export function measureSections(
  sections: Record<string, string>,
  options: { joined?: string } = {},
): PromptBreakdown {
  const parts: Record<string, number> = {};
  for (const [key, value] of Object.entries(sections)) {
    parts[key] = estimateTokens(value);
  }
  const joined = options.joined ?? Object.values(sections).join("\n");
  return { parts, total: estimateTokens(joined) };
}
