// server/src/myrmidon/prompt-budget/attention.ts
//
// myrmidon(1.6.3 PROMPT-BUDGET B): the attention-feed cards of the prompt
// budget.
//
// One card per agent whose last run crossed a threshold, built from the same
// live status the API reports. The feed recomputes on every list, so nothing
// is persisted here — the card exists exactly while the last run is over the
// threshold, and disappears or re-grades (warn ↔ crit) the moment a newer run
// says otherwise.

import type { AttentionSeverity } from "@paperclipai/shared";
import {
  PROMPT_BUDGET_ATTENTION_DEDUP_PREFIX,
  topPromptBudgetParts,
  type PromptBudgetAgentStatus,
} from "@paperclipai/shared";

/** One attention card the feed renders for an over-threshold agent. */
export interface PromptBudgetAttentionCard {
  agentId: string;
  agentName: string | null;
  dedupKey: string;
  title: string;
  whyNow: string;
  severity: AttentionSeverity;
  summaryExcerpt: string;
  level: "warn" | "crit";
  metadata: Record<string, unknown>;
}

function buildWhyNow(status: PromptBudgetAgentStatus): string {
  const run = status.lastRun;
  if (!run) return "";
  const threshold =
    run.level === "crit" ? status.settings.critPct : status.settings.warnPct;
  const windowNote = status.windowIsFallback
    ? `the fallback window of ${status.windowTokens} tokens (the model's window is unknown)`
    : `the model window of ${status.windowTokens} tokens`;
  const top = topPromptBudgetParts(run.parts, 3);
  const partsNote =
    top.length > 0
      ? ` Biggest parts: ${top.map((part) => `${part.name} ${part.tokens}`).join(", ")} tokens.`
      : "";
  return `The last run's prompt used ${run.pct}% of ${windowNote} (${run.total} tokens), over the ${run.level} threshold of ${threshold}%.${partsNote}`;
}

function buildTitle(status: PromptBudgetAgentStatus, agentName: string | null): string {
  const label = agentName ?? "An agent";
  const run = status.lastRun;
  if (!run) return `${label} prompt budget`;
  return run.level === "crit"
    ? `${label} prompt is at ${run.pct}% of its context window`
    : `${label} prompt reached ${run.pct}% of its context window`;
}

/**
 * Build the cards for every status row whose last run is over a threshold.
 * `agentNameById` supplies the display names (the caller reads them once with
 * the agents query).
 */
export function buildPromptBudgetAttentionCards(
  statuses: readonly PromptBudgetAgentStatus[],
  agentNameById: ReadonlyMap<string, string>,
): PromptBudgetAttentionCard[] {
  return statuses
    .filter((status) => status.lastRun !== null && status.lastRun.level !== "ok")
    .map((status) => {
      const run = status.lastRun!;
      const level = run.level as "warn" | "crit";
      const agentName = agentNameById.get(status.agentId) ?? null;
      const whyNow = buildWhyNow(status);
      return {
        agentId: status.agentId,
        agentName,
        dedupKey: `${PROMPT_BUDGET_ATTENTION_DEDUP_PREFIX}:${status.agentId}`,
        title: buildTitle(status, agentName),
        whyNow,
        severity: (level === "crit" ? "high" : "medium") as AttentionSeverity,
        summaryExcerpt: whyNow,
        level,
        metadata: {
          originAgentId: status.agentId,
          model: status.model,
          windowTokens: status.windowTokens,
          windowIsFallback: status.windowIsFallback,
          runId: run.runId,
          total: run.total,
          pct: run.pct,
          level,
          topParts: topPromptBudgetParts(run.parts, 3),
        },
      };
    });
}
