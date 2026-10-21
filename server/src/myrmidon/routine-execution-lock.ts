import { and, desc, eq, inArray, or, type SQL } from "drizzle-orm";
import { issues, type Db } from "@myrmidonai/db";
import { visibleIssueCondition } from "../services/issue-visibility.js";

/**
 * The routine-execution lock the database already enforces.
 *
 * `issues_open_routine_execution_uq` is a partial unique index over
 * `(company_id, origin_kind, origin_id, origin_fingerprint)` for visible rows
 * with `origin_kind = 'routine_execution'`, an open status and a non-null
 * `execution_run_id`. It guarantees "at most one open execution per routine
 * fingerprint", but only once an issue holds an execution run.
 *
 * The vendor coalescing lookup (`findLiveExecutionIssue` in
 * `services/routines.ts`) is narrower: it matches an existing execution only
 * while its heartbeat run is `queued` / `running` / `scheduled_retry`. A
 * routine execution whose run finished while its issue stayed open is
 * therefore invisible to it, and the next dispatch inserts a second issue —
 * allowed, because the new row carries no `execution_run_id` yet, so the
 * partial index does not cover the insert. The duplicate only surfaces later,
 * when that issue's run starts and stamps `execution_run_id`: the update then
 * violates the index, the run fails on a duplicate key, and the duplicate
 * issue stays open.
 *
 * This lookup matches any open routine execution for the same dispatch,
 * including queued issues that have not acquired an execution run yet. Callers
 * coalesce against it instead of creating another issue while it remains open.
 */

/**
 * Open statuses of a routine execution that prevent another issue from being
 * created. Keep terminal states excluded; unlike the partial index predicate,
 * this lookup intentionally includes issues without an execution run yet.
 */
const OPEN_EXECUTION_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"] as const;

export const ROUTINE_EXECUTION_ORIGIN_KIND = "routine_execution";

/**
 * Fingerprint condition matching the index key, plus the legacy `default`
 * fingerprint arm the vendor keeps for pre-migration open executions.
 */
export function routineExecutionFingerprintCondition(
  dispatchFingerprint?: string | null,
): SQL | null {
  if (!dispatchFingerprint) return null;
  return or(
    eq(issues.originFingerprint, dispatchFingerprint),
    eq(issues.originFingerprint, "default"),
  )!;
}

/**
 * The open routine execution holding the index key for this dispatch, if any.
 *
 * `originKind` is the issue origin kind used by the caller: managed
 * (plugin-operation) routines carry their own kind, which the index does not
 * cover, so they are not matched here and keep the vendor behavior.
 */
export async function findOpenRoutineExecutionIssue(
  executor: Db,
  input: {
    companyId: string;
    originKind: string;
    originId: string | null;
    dispatchFingerprint?: string | null;
  },
) {
  if (input.originKind !== ROUTINE_EXECUTION_ORIGIN_KIND || !input.originId) return null;
  const fingerprintCondition = routineExecutionFingerprintCondition(input.dispatchFingerprint);
  return executor
    .select()
    .from(issues)
    .where(
      and(
        eq(issues.companyId, input.companyId),
        eq(issues.originKind, ROUTINE_EXECUTION_ORIGIN_KIND),
        eq(issues.originId, input.originId),
        inArray(issues.status, [...OPEN_EXECUTION_STATUSES]),
        visibleIssueCondition(),
        ...(fingerprintCondition ? [fingerprintCondition] : []),
      ),
    )
    .orderBy(desc(issues.updatedAt), desc(issues.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}