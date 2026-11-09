// server/src/modules/issues/application/queue-reflect-job.ts
//
// myrmidon(1.7 POST-TASK-REFLECT, OPE-12095): status change hook that enqueues
// a post-task-reflect job when an issue is marked done.

import {
  computeReflectJobDedupKey,
  shouldEnqueueReflectJob,
} from "../domain/reflect-job.js";
import type {
  IssueStatusChangeEvent,
  ModuleLogger,
  ReflectJobRepository,
  StatusChangeHookResult,
} from "./ports.js";

const defaultLogger: ModuleLogger = {
  warn(obj: Record<string, unknown>, msg?: string) {
    if (typeof console !== "undefined" && typeof console.warn === "function") {
      console.warn(`[issues-module:reflect-hook] ${msg ?? "warn"}:`, obj);
    }
  },
};

export interface QueueReflectJobDeps {
  repository: ReflectJobRepository;
  logger?: ModuleLogger;
}

/**
 * Handles issue status transitions.
 * When `toStatus` is "done", automatically enqueues a post-task-reflect job
 * into the `reflect_jobs` table.
 *
 * Guarantees:
 * 1. Exactly-once: dedupKey ensures repeated transitions to "done" or repeated
 *    calls do not duplicate reflect jobs.
 * 2. Non-blocking & fault-tolerant: unexpected repository errors are caught
 *    and logged without crashing the issue status update workflow.
 */
export async function handleIssueStatusChange(
  event: IssueStatusChangeEvent,
  deps: QueueReflectJobDeps,
): Promise<StatusChangeHookResult> {
  const logger = deps.logger ?? defaultLogger;

  try {
    const shouldEnqueue = shouldEnqueueReflectJob(event.fromStatus, event.toStatus);
    if (!shouldEnqueue) {
      const reason =
        String(event.toStatus ?? "").trim().toLowerCase() !== "done"
          ? "status_not_done"
          : "already_done";

      return {
        handled: true,
        enqueued: false,
        reason,
      };
    }

    const dedupKey = computeReflectJobDedupKey(event.issueId, "done");

    const result = await deps.repository.enqueueReflectJob({
      companyId: event.companyId,
      issueId: event.issueId,
      jobType: "post_task_reflect",
      event: "done",
      dedupKey,
      role: event.role ?? null,
      assigneeAgentId: event.assigneeAgentId ?? null,
      payload: event.payload ?? {},
    });

    if (result.alreadyExisted) {
      return {
        handled: true,
        enqueued: false,
        reason: "duplicate_dedup_key",
        job: result.job,
      };
    }

    return {
      handled: true,
      enqueued: true,
      job: result.job,
    };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.warn(
      {
        err: error,
        issueId: event.issueId,
        companyId: event.companyId,
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
      },
      "Failed to enqueue post-task-reflect job on issue status change; caught safely",
    );

    return {
      handled: false,
      enqueued: false,
      error,
    };
  }
}

/**
 * Factory for creating an issue status change hook bound to dependencies.
 */
export function createOnIssueStatusChangeHook(
  deps: QueueReflectJobDeps,
): (event: IssueStatusChangeEvent) => Promise<StatusChangeHookResult> {
  return (event: IssueStatusChangeEvent) => handleIssueStatusChange(event, deps);
}
