// packages/shared/src/myrmidon-project-token-quota.ts
//
// myrmidon(1.6.6 QUOTA-V2): the shared contract of the project token quota —
// per-project daily/weekly token limits, stored as their own table
// (`project_token_quotas`, one row per project), checked when an agent run is
// enqueued, refused with a stable code and a readable sentence.
//
// The quota row is per project and per window kind (daily, weekly); either
// limit may be absent (`null` = that window is unlimited). The usage the limit
// is compared against is the sum of input+cached_input+output tokens of the
// cost events attributed to the project over the window (the same attribution
// the cost report uses: `cost_events.project_id`, with the run-project
// fallback handled server-side). The window resets on the UTC day/ISO-week
// boundary, the same way the heartbeat daily cap resets.
//
// `null`/absent quota = enforcement off: no check, no rejection, no signal —
// the default for every project until an operator sets a limit.

import { z } from "zod";

/** The stable rejection code an over-quota project sees at enqueue time. */
export const PROJECT_TOKEN_QUOTA_EXCEEDED_ERROR_CODE = "PROJECT_TOKEN_QUOTA_EXCEEDED";

/** The window kinds a project token quota can be set for. */
export const PROJECT_TOKEN_QUOTA_WINDOW_KINDS = ["daily", "weekly"] as const;
export type ProjectTokenQuotaWindowKind = (typeof PROJECT_TOKEN_QUOTA_WINDOW_KINDS)[number];

/** Tokens counted as one number: input + cached input + output. */
export function sumCostEventTokens(input: {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}): number {
  return input.inputTokens + input.cachedInputTokens + input.outputTokens;
}

const tokenLimitSchema = z.number().int().min(1).max(100_000_000_000);

/** Body of `PUT .../project-token-quota` — one project, both windows at once. */
export const projectTokenQuotaSchema = z
  .object({
    dailyTokenLimit: tokenLimitSchema.nullable(),
    weeklyTokenLimit: tokenLimitSchema.nullable(),
  })
  .strict();

export type ProjectTokenQuotaInput = z.infer<typeof projectTokenQuotaSchema>;

/** The stored quota row, normalized: null limits = unlimited. */
export interface ProjectTokenQuota {
  projectId: string;
  dailyTokenLimit: number | null;
  weeklyTokenLimit: number | null;
}

/** The answer of the quota check at enqueue: the first window that is over. */
export interface ProjectTokenQuotaBlock {
  projectId: string;
  projectName: string;
  windowKind: ProjectTokenQuotaWindowKind;
  tokenLimit: number;
  tokensUsed: number;
}

/**
 * The message of the refusal the caller of enqueue sees. The stable code
 * first: an agent parses it, the sentence explains it.
 */
export function projectTokenQuotaRejectionMessage(block: {
  projectName: string;
  windowKind: ProjectTokenQuotaWindowKind;
  tokensUsed: number;
  tokenLimit: number;
}): string {
  const windowWord = block.windowKind === "daily" ? "daily" : "weekly";
  return (
    `${PROJECT_TOKEN_QUOTA_EXCEEDED_ERROR_CODE}: project "${block.projectName}" is over its ` +
    `${windowWord} token quota (${block.tokensUsed.toLocaleString("en-US")} of ` +
    `${block.tokenLimit.toLocaleString("en-US")} tokens used). New runs for this project are ` +
    `refused until the ${windowWord} window resets or the quota is raised.`
  );
}
