// myrmidon(OPE-13099): an agent that hands a task to review (`status: "in_review"`)
// while the task has no review stage gets one built by the board: every
// eligible reviewer of the executor's own group becomes a participant, and the
// execution-policy transition then picks the least loaded one (candidateLoads).

import { ownGroupReviewerPool } from "./policy.js";

export interface HandoffReviewerRow {
  id: string;
  name?: string | null;
  metadata?: unknown;
  swarmQueueEligible?: boolean;
  invokable?: boolean;
}

/** Agent ids of the reviewers that may be put on the new stage; empty = add nothing. */
export function selectHandoffReviewerIds(input: {
  reviewers: readonly HandoffReviewerRow[];
  groupKey: string;
  excludedAgentIds: Iterable<string>;
}): string[] {
  const excluded = new Set(input.excludedAgentIds);
  return ownGroupReviewerPool(input.reviewers, input.groupKey)
    .filter((reviewer) => reviewer.invokable !== false && !excluded.has(reviewer.id))
    .map((reviewer) => reviewer.id)
    .sort();
}

/**
 * The previous policy untouched plus one review stage. The review stage goes
 * first so that an existing approval stage still runs after it. Returns null
 * when there is nobody to put on the stage or a review stage already exists.
 */
export function buildHandoffReviewPolicy(
  previous: Record<string, unknown> | null,
  reviewerIds: readonly string[],
): Record<string, unknown> | null {
  if (reviewerIds.length === 0) return null;
  const stages = Array.isArray(previous?.stages) ? [...previous.stages] : [];
  const hasReviewStage = stages.some(
    (stage) => (stage as { type?: unknown } | null)?.type === "review",
  );
  if (hasReviewStage) return null;
  return {
    ...(previous ?? { mode: "normal" }),
    stages: [
      {
        type: "review",
        approvalsNeeded: 1,
        participants: reviewerIds.map((agentId) => ({ type: "agent", agentId })),
      },
      ...stages,
    ],
  };
}
