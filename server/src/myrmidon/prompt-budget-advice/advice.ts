// server/src/myrmidon/prompt-budget-advice/advice.ts
//
// myrmidon(1.6.3 PROMPT-BUDGET C): the static optimization-advice generator.
//
// A pure function over one run's prompt breakdown (the per-part token counts and
// their total). It never touches the database and never calls a model: the table
// of rules in this file maps the dominant part of a prompt to a concrete
// recommendation — "which part is bloated and what to do about it". A part is
// bloated when its share of the prompt crosses a threshold; the biggest parts
// come first.
//
// The part keys are produced by the per-run accounting of the same release
// (`heartbeat_runs.usageJson.promptBreakdown.parts`) and are NOT fixed strings
// here: every rule matches a part key case-insensitively, so a renamed or newly
// added part still receives a recommendation, and a part no rule names falls
// through to the generic rule. All thresholds are constants of this module, not
// settings: they decide when advice is worth showing, not what the product
// policy is.

import type { PromptRunBreakdown } from "./source.js";

export type { PromptRunBreakdown } from "./source.js";

/** A part worth a recommendation from this share of the prompt (percent). */
export const PROMPT_BUDGET_ADVICE_SHARE_PCT = 30;

/** A part this large is critical rather than a warning (percent). */
export const PROMPT_BUDGET_ADVICE_CRIT_SHARE_PCT = 50;

/**
 * Below this many tokens the prompt is small regardless of one part's share, so
 * no advice is produced — a short prompt has nothing worth restructuring.
 */
export const PROMPT_BUDGET_ADVICE_MIN_TOTAL_TOKENS = 2000;

export type PromptBudgetAdviceSeverity = "warn" | "crit";

/** One part of the prompt with its share of the whole. */
export interface PromptBudgetAdvicePart {
  part: string;
  tokens: number;
  sharePct: number;
}

/** One concrete recommendation: the bloated part and the action to take. */
export interface PromptBudgetAdviceItem {
  /** Id of the rule that produced this item (stable across releases). */
  ruleId: string;
  /** The part key as recorded in the breakdown. */
  part: string;
  tokens: number;
  sharePct: number;
  severity: PromptBudgetAdviceSeverity;
  /** Short label of the bloated part, for the panel heading. */
  title: string;
  /** The concrete action to take. */
  action: string;
}

/** The advice body: `GET .../prompt-budget/agents/:agentId/advice`. */
export interface PromptBudgetAdvice {
  agentId: string;
  /** False when the agent has no run with a recorded breakdown. */
  hasRun: boolean;
  runId: string | null;
  total: number;
  /** Every part of the run, biggest first — the panel's breakdown bars. */
  parts: PromptBudgetAdvicePart[];
  /** True when nothing crosses a threshold (or the prompt is too small). */
  healthy: boolean;
  recommendations: PromptBudgetAdviceItem[];
}

interface AdviceRule {
  id: string;
  /** Matched against the part key, case-insensitively. */
  pattern: RegExp;
  title: string;
  action: string;
}

/**
 * The rule table, in match order: the first rule whose pattern matches a part
 * key describes that part. The last entry is the fallback, so every part always
 * gets an action.
 */
const ADVICE_RULES: readonly AdviceRule[] = [
  {
    id: "instructions",
    pattern: /instruction|system|identity|contract|bundle|preamble|prompt.?file|agent.?card/i,
    title: "Instructions bundle",
    action:
      "Move reference material out of the always-on instructions bundle into skills loaded on demand; keep only the operating rules in the bundle.",
  },
  {
    id: "skills",
    pattern: /skill|inject/i,
    title: "Skills and injections",
    action:
      "Turn off the skills this agent does not need on every run, or move their bodies behind an on-demand lookup.",
  },
  {
    id: "session-history",
    pattern: /session|handoff|history|continuation|transcript|conversation/i,
    title: "Session history and handoff",
    action:
      "Use a run-scoped session strategy instead of an issue-scoped one, and compress the handoff instead of carrying the whole history.",
  },
  {
    id: "tool-results",
    pattern: /tool|result|output|attachment|artifact|file.?content/i,
    title: "Tool results and attachments",
    action:
      "Trim tool results and attachments before they enter the prompt: ask for less output, summarise large payloads, keep files out of the context.",
  },
  {
    id: "wake-payload",
    pattern: /wake.?payload|payload|wake.?json/i,
    title: "Wake payload JSON",
    action: "Shrink the wake payload the wake-up carries: fewer fields, no bulky embedded JSON.",
  },
  {
    id: "task-markdown",
    pattern: /task|issue.?(markdown|description|body)|description/i,
    title: "Task markdown",
    action:
      "Shorten the task markdown carried into the prompt: link to the document instead of pasting it.",
  },
  {
    id: "wake-prompt",
    pattern: /wake/i,
    title: "Wake prompt",
    action: "Trim the wake prompt scaffolding: the repeated boilerplate around the actual request.",
  },
  {
    id: "generic",
    pattern: /.*/,
    title: "Dominant prompt part",
    action:
      "Review this part: it is the largest share of the prompt; cut what is not needed on every run.",
  },
];

/** The rule that describes a part key (the fallback rule always matches). */
export function adviceRuleFor(partKey: string): AdviceRule {
  return ADVICE_RULES.find((rule) => rule.pattern.test(partKey)) ?? ADVICE_RULES[ADVICE_RULES.length - 1]!;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Normalise the recorded parts: finite positive token counts only, biggest
 * first, ties broken by part key so the order is stable across runs.
 */
function normaliseParts(parts: Record<string, number>): Array<{ part: string; tokens: number }> {
  return Object.entries(parts)
    .filter(([, tokens]) => typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0)
    .map(([part, tokens]) => ({ part, tokens: Math.round(tokens) }))
    .sort((left, right) => right.tokens - left.tokens || left.part.localeCompare(right.part));
}

/**
 * Build the advice for one agent's last run. A `null` run means the agent has no
 * recorded breakdown: the answer is empty and says so (`hasRun: false`) rather
 * than pretending the prompt is healthy.
 */
export function buildPromptBudgetAdvice(input: {
  agentId: string;
  run: PromptRunBreakdown | null;
}): PromptBudgetAdvice {
  const run = input.run;
  const total = run ? Math.max(0, Math.round(run.total || 0)) : 0;
  const parts = run ? normaliseParts(run.parts) : [];
  const shared = parts.map((entry) => {
    const share = total > 0 ? (entry.tokens / total) * 100 : 0;
    return { part: entry.part, tokens: entry.tokens, share, sharePct: round1(share) };
  });

  const recommendations: PromptBudgetAdviceItem[] =
    total >= PROMPT_BUDGET_ADVICE_MIN_TOTAL_TOKENS
      ? shared
          .filter((entry) => entry.share >= PROMPT_BUDGET_ADVICE_SHARE_PCT)
          .map((entry) => {
            const rule = adviceRuleFor(entry.part);
            return {
              ruleId: rule.id,
              part: entry.part,
              tokens: entry.tokens,
              sharePct: entry.sharePct,
              severity:
                entry.share >= PROMPT_BUDGET_ADVICE_CRIT_SHARE_PCT
                  ? ("crit" as const)
                  : ("warn" as const),
              title: rule.title,
              action: rule.action,
            };
          })
      : [];

  return {
    agentId: input.agentId,
    hasRun: run !== null,
    runId: run?.runId ?? null,
    total,
    parts: shared.map(({ part, tokens, sharePct }) => ({ part, tokens, sharePct })),
    healthy: recommendations.length === 0,
    recommendations,
  };
}