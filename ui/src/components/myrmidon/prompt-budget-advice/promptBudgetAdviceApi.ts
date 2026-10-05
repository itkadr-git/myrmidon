// myrmidon(1.6.3 PROMPT-BUDGET C): API client for the prompt-budget advice.
//
// The advice routes of the same release:
//
//   GET  /api/myrmidon/companies/:companyId/prompt-budget/agents/:agentId/advice
//        -> { agentId, agentName, model, hasRun, runId, total, parts,
//             healthy, recommendations }
//   POST /api/myrmidon/companies/:companyId/prompt-budget/agents/:agentId/advice/deep
//        -> 201 { issueId, identifier, title }  (422 without a configured optimizer agent)
//
// The status/thresholds endpoints are owned by the sibling part of the release;
// this client touches only the advice endpoints, so the panel mounts on its own.

import { api } from "@/api/client";

/** One part of the last prompt with its share. */
export interface PromptBudgetAdvicePart {
  part: string;
  tokens: number;
  sharePct: number;
}

/** One recommendation: the bloated part and the action to take. */
export interface PromptBudgetAdviceItem {
  ruleId: string;
  part: string;
  tokens: number;
  sharePct: number;
  severity: "warn" | "crit";
  title: string;
  action: string;
}

/** The advice body of one agent. */
export interface PromptBudgetAdvice {
  agentId: string;
  agentName?: string;
  model?: string | null;
  hasRun: boolean;
  runId: string | null;
  total: number;
  parts: PromptBudgetAdvicePart[];
  healthy: boolean;
  recommendations: PromptBudgetAdviceItem[];
}

/** The deep-analysis task the POST answers with. */
export interface PromptBudgetDeepTask {
  issueId: string;
  /** Absent only for a task that has no identifier yet; the panel then shows the id. */
  identifier: string | null;
  title: string;
}

export const promptBudgetAdviceQueryKey = (companyId: string, agentId: string) =>
  ["myrmidon", "prompt-budget", "advice", companyId, agentId] as const;

const advicePath = (companyId: string, agentId: string) =>
  `/myrmidon/companies/${encodeURIComponent(companyId)}/prompt-budget/agents/${encodeURIComponent(agentId)}/advice`;

export const promptBudgetAdviceApi = {
  getAdvice: (companyId: string, agentId: string) =>
    api.get<PromptBudgetAdvice>(advicePath(companyId, agentId)),
  startDeepAnalysis: (companyId: string, agentId: string) =>
    api.post<PromptBudgetDeepTask>(`${advicePath(companyId, agentId)}/deep`, {}),
};