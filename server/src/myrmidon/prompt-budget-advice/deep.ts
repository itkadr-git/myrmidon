// server/src/myrmidon/prompt-budget-advice/deep.ts
//
// myrmidon(1.6.3 PROMPT-BUDGET C): the task the deep-analysis button files.
//
// The static advice is cheap and mechanical; the deep pass is a real agent run
// on a cheap model. This file builds that agent's task: the target agent, its
// last run's breakdown and the recommendations already known are written into
// the description, and the task asks for a DRAFT of instruction/configuration
// edits posted back as a comment. The task itself changes nothing — it is a
// review request, so the deep pass cannot silently edit another agent.

import type { PromptBudgetAdvice } from "./advice.js";
import type { PromptBudgetAgentRef, PromptRunBreakdown } from "./source.js";

/** The task input handed to the issue creator. */
export interface DeepAnalysisTask {
  title: string;
  description: string;
  assigneeAgentId: string;
  status: "todo";
  priority: "medium";
  originKind: "manual";
  /** Dedup key: one deep task per target agent per run. */
  originId: string;
  idempotencyKey: string;
}

function modelLabel(ref: PromptBudgetAgentRef): string {
  return ref.model ?? "not set on the card";
}

/** The dedup key of the deep task of one target agent and run. */
export function deepAnalysisOriginId(agentId: string, runId: string | null): string {
  return `prompt-budget-advice:${agentId}:${runId ?? "no-run"}`;
}

/** Build the full task (title, description, assignee) for the optimizer agent. */
export function buildDeepAnalysisTask(input: {
  target: PromptBudgetAgentRef;
  run: PromptRunBreakdown;
  advice: PromptBudgetAdvice;
  optimizerAgentId: string;
}): DeepAnalysisTask {
  const { target, run, advice, optimizerAgentId } = input;

  const breakdownRows = advice.parts.length > 0
    ? advice.parts
        .map((part) => `| ${part.part} | ${part.tokens} | ${part.sharePct}% |`)
        .join("\n")
    : "| (no per-part breakdown recorded) | - | - |";

  const knownRecommendations = advice.recommendations.length > 0
    ? advice.recommendations
        .map((item) => `- **${item.title}** (${item.part}, ${item.sharePct}%, ${item.tokens} tokens): ${item.action}`)
        .join("\n")
    : "- None: no part crosses the warning threshold.";

  const description = [
    "Deep prompt-budget analysis. The agent card's \"Deep analysis\" button filed this task.",
    "",
    "## Target agent",
    `- Agent id: ${target.agentId}`,
    `- Name: ${target.name}`,
    `- Model: ${modelLabel(target)}`,
    "",
    "## Last run prompt breakdown",
    `- Run id: ${run.runId ?? "unknown"}`,
    `- Total prompt tokens: ${run.total}`,
    "",
    "| Part | Tokens | Share |",
    "| --- | --- | --- |",
    breakdownRows,
    "",
    "## Recommendations already produced statically",
    knownRecommendations,
    "",
    "## What to do",
    "1. Work from the breakdown above: name the parts that dominate the prompt and why.",
    "2. Produce a DRAFT of concrete edits that would shrink them — for each edit state what",
    "   changes (instructions bundle, skills, session strategy, wake payload, task markdown),",
    "   the exact text or setting to change, and the expected token saving.",
    "3. Post that draft as a single comment on this task and finish.",
    "",
    "## Constraints",
    "- Do not change any agent configuration, instructions file or setting: this task only",
    "  produces a draft for a human to review.",
    "- Keep it short: the draft is a review aid, not a report.",
  ].join("\n");

  return {
    title: `Prompt budget deep analysis: ${target.name}`,
    description,
    assigneeAgentId: optimizerAgentId,
    status: "todo",
    priority: "medium",
    originKind: "manual",
    originId: deepAnalysisOriginId(target.agentId, run.runId),
    idempotencyKey: deepAnalysisOriginId(target.agentId, run.runId),
  };
}