/**
 * Thin run-context columns for `heartbeat_runs`.
 *
 * The run's `context_snapshot` jsonb carries tens to hundreds of KB of wake
 * payload, prompts, and transcripts. Hot list queries (the run list, the
 * attention feed) only need a handful of scalar fields from it, and every
 * `context_snapshot ->> 'key'` detoasts the whole value. These helpers make
 * the wide columns the source of truth for new rows while keeping the
 * snapshot as the fallback for historical rows:
 *
 * - `runContextPersistenceFields(contextSnapshot)` builds the full `.values()`
 *   / `.set()` fragment: the nine thin columns derived from the same object
 *   that goes into `context_snapshot`, plus a persisted snapshot with the
 *   `executionContinuation` duplicate stripped (the operator still receives
 *   it in the wake payload, which is built from memory, not from this row).
 * - `heartbeatRunListContextColumnProjections` is the SELECT fragment the
 *   run list and attention feed read: `coalesce(<thin column>,
 *   context_snapshot ->> '<key>')`. Coalesce short-circuits when the thin
 *   column is non-null, so new rows never detoast the snapshot.
 */
import { SQL, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { heartbeatRuns } from "./schema/heartbeat_runs.js";

export const HEARTBEAT_RUN_CONTEXT_SUMMARY_MAX_CHARS = 512;

/** Keys of the context snapshot that duplicate wake payloads into the row. */
export const RUN_CONTEXT_NON_PERSISTED_KEY = "executionContinuation";

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readObjective(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return nonEmptyString((value as Record<string, unknown>).objective);
}

export type HeartbeatRunContextColumnValues = {
  contextIssueId: string | null;
  contextTaskId: string | null;
  contextTaskKey: string | null;
  contextCommentId: string | null;
  contextWakeCommentId: string | null;
  contextWakeReason: string | null;
  contextWakeSource: string | null;
  contextWakeTriggerDetail: string | null;
  contextRunSummary: string | null;
};

/**
 * Derives the nine thin column values from a context snapshot object. The
 * summary column carries the short task label (`taskTitle`, falling back to
 * the continuation `objective`) so list views keep a readable summary even
 * after `executionContinuation` stopped being persisted.
 */
export function readRunContextColumnValues(
  contextSnapshot: Record<string, unknown> | null | undefined,
): HeartbeatRunContextColumnValues {
  const source = contextSnapshot ?? {};
  const summary =
    nonEmptyString(source.taskTitle) ??
    readObjective(source[RUN_CONTEXT_NON_PERSISTED_KEY]);
  return {
    contextIssueId: nonEmptyString(source.issueId),
    contextTaskId: nonEmptyString(source.taskId),
    contextTaskKey: nonEmptyString(source.taskKey),
    contextCommentId: nonEmptyString(source.commentId),
    contextWakeCommentId: nonEmptyString(source.wakeCommentId),
    contextWakeReason: nonEmptyString(source.wakeReason),
    contextWakeSource: nonEmptyString(source.wakeSource),
    contextWakeTriggerDetail: nonEmptyString(source.wakeTriggerDetail),
    contextRunSummary: summary
      ? summary.slice(0, HEARTBEAT_RUN_CONTEXT_SUMMARY_MAX_CHARS)
      : null,
  };
}

/**
 * Copy of the snapshot without the `executionContinuation` duplicate. The
 * in-memory context keeps the envelope (wake payload, resumeDelta logic);
 * only the persisted row drops it.
 */
export function stripRunContextForPersistence<T extends Record<string, unknown>>(
  contextSnapshot: T | null | undefined,
): Record<string, unknown> | null {
  if (contextSnapshot == null) return null;
  if (
    typeof contextSnapshot !== "object" ||
    Array.isArray(contextSnapshot) ||
    !(RUN_CONTEXT_NON_PERSISTED_KEY in contextSnapshot)
  ) {
    return contextSnapshot;
  }
  const { [RUN_CONTEXT_NON_PERSISTED_KEY]: _dropped, ...rest } = contextSnapshot;
  return rest;
}

/**
 * Full write fragment for insert/update of a run row that carries a context
 * snapshot: the stripped snapshot plus its nine thin columns, computed from
 * the same object so the columns can never drift from the snapshot.
 */
export function runContextPersistenceFields(
  contextSnapshot: Record<string, unknown> | null | undefined,
): { contextSnapshot: Record<string, unknown> | null } & HeartbeatRunContextColumnValues {
  // Column values are computed from the full snapshot (the summary falls back
  // to the continuation objective), then the duplicate is stripped for storage.
  const columns = readRunContextColumnValues(contextSnapshot);
  return {
    contextSnapshot: stripRunContextForPersistence(contextSnapshot),
    ...columns,
  };
}

/**
 * Normalize an insert/update patch for `heartbeat_runs`: when the patch
 * carries a plain-object `contextSnapshot`, it is replaced by
 * `runContextPersistenceFields` so every write keeps the nine thin columns
 * and the snapshot in lockstep. SQL-managed snapshot patches (jsonb merges)
 * pass through untouched — they never add or remove thin fields.
 */
export function runContextWritePatch<T extends object>(patch: T): T {
  if (!patch || typeof patch !== "object" || !("contextSnapshot" in patch)) {
    return patch;
  }
  const value = (patch as { contextSnapshot?: unknown }).contextSnapshot;
  if (value instanceof SQL) return patch;
  if (value !== null && typeof value === "object") {
    // Only plain snapshot records are derived from; column references and
    // other SQL-managed values pass through untouched.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return patch;
  } else if (value !== null) {
    return patch;
  }
  const rest = { ...patch } as Record<string, unknown>;
  delete rest.contextSnapshot;
  return {
    ...rest,
    ...runContextPersistenceFields(value as Record<string, unknown> | null),
  } as unknown as T;
}

function coalesceContextColumn(
  column: PgColumn,
  snapshotKey: string,
  alias: string,
) {
  return sql<string | null>`coalesce(${column}, ${heartbeatRuns.contextSnapshot} ->> ${snapshotKey})`.as(
    alias,
  );
}

/**
 * SELECT projection for the thin context fields, safe for historical rows:
 * reads the wide column first and only detoasts the snapshot for rows whose
 * column is still NULL (pre-migration inserts).
 */
export const heartbeatRunListContextColumnProjections = {
  contextIssueId: coalesceContextColumn(
    heartbeatRuns.contextIssueId,
    "issueId",
    "contextIssueId",
  ),
  contextTaskId: coalesceContextColumn(
    heartbeatRuns.contextTaskId,
    "taskId",
    "contextTaskId",
  ),
  contextTaskKey: coalesceContextColumn(
    heartbeatRuns.contextTaskKey,
    "taskKey",
    "contextTaskKey",
  ),
  contextCommentId: coalesceContextColumn(
    heartbeatRuns.contextCommentId,
    "commentId",
    "contextCommentId",
  ),
  contextWakeCommentId: coalesceContextColumn(
    heartbeatRuns.contextWakeCommentId,
    "wakeCommentId",
    "contextWakeCommentId",
  ),
  contextWakeReason: coalesceContextColumn(
    heartbeatRuns.contextWakeReason,
    "wakeReason",
    "contextWakeReason",
  ),
  contextWakeSource: coalesceContextColumn(
    heartbeatRuns.contextWakeSource,
    "wakeSource",
    "contextWakeSource",
  ),
  contextWakeTriggerDetail: coalesceContextColumn(
    heartbeatRuns.contextWakeTriggerDetail,
    "wakeTriggerDetail",
    "contextWakeTriggerDetail",
  ),
} as const;

/** issueId/taskId coalesce pair used by the attention feed projections. */
export const attentionRunIssueTaskColumns = {
  runIssueId: sql<string | null>`coalesce(${heartbeatRuns.contextIssueId}, ${heartbeatRuns.contextSnapshot} ->> 'issueId')`.as(
    "runIssueId",
  ),
  runTaskId: sql<string | null>`coalesce(${heartbeatRuns.contextTaskId}, ${heartbeatRuns.contextSnapshot} ->> 'taskId')`.as(
    "runTaskId",
  ),
} as const;
