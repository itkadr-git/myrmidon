// server/src/modules/issues/domain/reflect-job.ts
//
// myrmidon(1.7 POST-TASK-REFLECT, OPE-12095): pure domain types and logic
// for post-task-reflect outbox jobs.
//
// Rules:
// - Domain layer does NOT depend on database, node runtime, services, or adapters.
// - Status change hook triggers when issue status transitions to "done".
// - Exactly-once execution is enforced via dedupKey: `<issueId>:<event>`.
// - Repeated status update to "done" must not duplicate an existing job.

export const REFLECT_JOB_STATUSES = ["pending", "running", "completed", "failed"] as const;
export type ReflectJobStatus = (typeof REFLECT_JOB_STATUSES)[number];

export const REFLECT_JOB_TYPES = ["post_task_reflect"] as const;
export type ReflectJobType = (typeof REFLECT_JOB_TYPES)[number];

export interface ReflectJob {
  id: string;
  companyId: string;
  issueId: string;
  jobType: string;
  status: ReflectJobStatus;
  dedupKey: string;
  event: string;
  role: string | null;
  assigneeAgentId: string | null;
  payload: Record<string, unknown>;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface NewReflectJobInput {
  companyId: string;
  issueId: string;
  jobType?: string;
  dedupKey?: string;
  event?: string;
  role?: string | null;
  assigneeAgentId?: string | null;
  payload?: Record<string, unknown>;
}

/**
 * Computes deterministic deduplication key for a reflect job.
 * Design §4.2: `<issueId>:<event>` (default event: "done").
 */
export function computeReflectJobDedupKey(issueId: string, event: string = "done"): string {
  const normalizedIssueId = String(issueId ?? "").trim();
  const normalizedEvent = String(event ?? "done").trim().toLowerCase();
  return `${normalizedIssueId}:${normalizedEvent}`;
}

/**
 * Checks whether an issue status transition should enqueue a post-task-reflect job.
 * Enqueue occurs when `toStatus` is "done" and the previous status was not "done".
 */
export function shouldEnqueueReflectJob(
  fromStatus: string | null | undefined,
  toStatus: string | null | undefined,
): boolean {
  const normalizedTo = String(toStatus ?? "").trim().toLowerCase();
  const normalizedFrom = fromStatus !== null && fromStatus !== undefined ? String(fromStatus).trim().toLowerCase() : null;

  if (normalizedTo !== "done") {
    return false;
  }

  if (normalizedFrom === "done") {
    return false;
  }

  return true;
}
