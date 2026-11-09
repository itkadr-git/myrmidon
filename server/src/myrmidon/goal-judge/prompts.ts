// server/src/myrmidon/goal-judge/prompts.ts
//
// myrmidon(1.7-GOAL-JUDGE): prompt templates for the goal achievement judge.
//
// Role: impartial goal judge evaluating whether an engineering task's goal
// has actually been reached.
// Core rule: "заявлено, но не проверено = не сделано" (claimed, but not verified = not done).
// Criteria without proof in diff or tests are classified as missing, and complete=false.

import type { GoalJudgeInput } from "./domain.js";

/** System prompt instructing the model to act as a strict goal judge with strict JSON output. */
export const GOAL_JUDGE_SYSTEM_PROMPT = `You are a strict, impartial goal-achievement judge for software engineering tasks.

Your duty is to inspect the task criteria, git diff, test output, and agent claims, then decide whether the goal is genuinely achieved.

CORE PRINCIPLE:
"Заявлено, но не проверено = не сделано" (Claimed, but not verified = not done).
- An objective or criterion is ONLY complete if there is concrete, verifiable proof in the git diff and/or test output.
- Stating that something is done without corresponding code changes or test evidence must be treated as UNMET / INCOMPLETE.
- Skipped tests, commented-out assertions, or mock-only passes that do not exercise the requirement are not proof of completion.
- If any criterion lacks proof in the diff or tests, it MUST be added to the "missing" list, and "complete" MUST be false.

STRICT INVARIANTS:
1. If "missing" is non-empty, "complete" MUST be false. Never set complete=true when missing has items.
2. Output MUST be a single, strict JSON object. Do not include markdown formatting, code fences, explanatory prose, or apologies outside the JSON object.

JSON SCHEMA:
{
  "score": <number between 0.0 and 1.0>,
  "complete": <boolean>,
  "missing": [<array of strings describing unmet or unverified criteria>],
  "summary": "<short 1-2 sentence assessment of evidence>"
}`;

/**
 * Builds the user prompt for the goal judge given task criteria, diff, and test output.
 */
export function buildGoalJudgeUserPrompt(
  input: GoalJudgeInput,
  options?: { round?: number; maxRounds?: number; previousFeedback?: string },
): string {
  const criteriaList = Array.isArray(input.criteria)
    ? input.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")
    : input.criteria;

  const sections: string[] = [
    "Evaluate whether the following task objective and acceptance criteria have been achieved.",
    "",
    "### ACCEPTANCE CRITERIA",
    criteriaList.trim() || "(None provided)",
  ];

  if (input.claims) {
    const claimsText = Array.isArray(input.claims)
      ? input.claims.map((c, i) => `- ${c}`).join("\n")
      : input.claims;
    sections.push("", "### AGENT CLAIMS / REPORT", claimsText.trim());
  }

  sections.push(
    "",
    "### GIT DIFF",
    input.diff && input.diff.trim().length > 0 ? input.diff.trim() : "(No git diff / empty change)",
  );

  sections.push(
    "",
    "### TEST OUTPUT",
    input.testOutput && input.testOutput.trim().length > 0
      ? input.testOutput.trim()
      : "(No test execution output provided)",
  );

  if (options?.round && options.round > 1) {
    sections.push(
      "",
      `### EVALUATION ROUND: ${options.round} of ${options.maxRounds ?? 3}`,
    );
  }

  if (options?.previousFeedback) {
    sections.push(
      "",
      "### PREVIOUS ROUND FEEDBACK",
      options.previousFeedback,
    );
  }

  sections.push(
    "",
    "### INSTRUCTIONS",
    'Remember the rule: "Заявлено, но не проверено = не сделано".',
    'Return ONLY a valid JSON object matching: {"score": number, "complete": boolean, "missing": string[], "summary": string}.',
    'If any criterion is unverified or missing, "missing" must list it and "complete" must be false.',
  );

  return sections.join("\n");
}

/**
 * Builds a correction prompt when a judge response failed parsing or violated invariants.
 */
export function buildGoalJudgeRetryPrompt(error: string, round: number): string {
  return [
    `Round ${round} output failed validation: ${error}`,
    'Please correct this immediately.',
    'Respond with ONLY a raw, valid JSON object with the exact keys: {"score": number, "complete": boolean, "missing": string[], "summary": string}.',
    'Remember: if missing is not empty, complete MUST be false.',
  ].join("\n");
}
