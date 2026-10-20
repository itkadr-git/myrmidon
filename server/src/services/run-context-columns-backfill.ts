/**
 * Background backfill of the thin `heartbeat_runs.context_*` columns.
 *
 * Migration 0309 only adds the columns (a catalog-only change). Filling them
 * for historical rows must not run inside the migration transaction: the
 * table is large, and one transaction would hold row locks on the hot table
 * until the whole pass commits. This job walks the primary key in small
 * batches and commits every batch on its own (each `db.execute` is a
 * standalone autocommit statement), pausing between batches so live traffic
 * keeps its share of IO. Readers never wait for it: they use
 * `coalesce(column, context_snapshot ->> key)`, so a row that is not yet
 * backfilled still resolves from the snapshot.
 *
 * The job is idempotent and safe to interrupt: the cursor lives in memory,
 * only rows whose thin columns are all still NULL and whose snapshot carries
 * at least one of the mirrored keys are written, and a restart simply walks
 * the table again, skipping rows that are already filled.
 */
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

export const RUN_CONTEXT_BACKFILL_BATCH_SIZE = 500;
export const RUN_CONTEXT_BACKFILL_PAUSE_MS = 250;

const MIRRORED_SNAPSHOT_KEYS = [
  "issueId",
  "taskId",
  "taskKey",
  "commentId",
  "wakeCommentId",
  "wakeReason",
  "wakeSource",
  "wakeTriggerDetail",
  "taskTitle",
  "executionContinuation",
] as const;

export type RunContextBackfillResult = {
  batches: number;
  scanned: number;
  updated: number;
};

export type RunContextBackfillOptions = {
  batchSize?: number;
  pauseMs?: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
};

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

/** Runs one batch after `cursor`; returns the next cursor (null when done). */
export async function backfillRunContextColumnsBatch(
  db: Pick<Db, "execute">,
  cursor: string | null,
  batchSize: number,
): Promise<{ nextCursor: string | null; scanned: number; updated: number }> {
  const idRows = rowsOf<{ id: string }>(
    await db.execute(sql`
      SELECT "id"::text AS "id" FROM "heartbeat_runs"
      WHERE ${cursor === null ? sql`true` : sql`"id" > ${cursor}::uuid`}
      ORDER BY "id"
      LIMIT ${batchSize}
    `),
  );
  if (idRows.length === 0) return { nextCursor: null, scanned: 0, updated: 0 };
  const ids = idRows.map((row) => row.id);
  const keyList = sql.join(
    MIRRORED_SNAPSHOT_KEYS.map((key) => sql`${key}`),
    sql`, `,
  );
  const updated = rowsOf<{ id: string }>(
    await db.execute(sql`
      UPDATE "heartbeat_runs" AS run
      SET
        "context_issue_id" = NULLIF(run."context_snapshot" ->> 'issueId', ''),
        "context_task_id" = NULLIF(run."context_snapshot" ->> 'taskId', ''),
        "context_task_key" = NULLIF(run."context_snapshot" ->> 'taskKey', ''),
        "context_comment_id" = NULLIF(run."context_snapshot" ->> 'commentId', ''),
        "context_wake_comment_id" = NULLIF(run."context_snapshot" ->> 'wakeCommentId', ''),
        "context_wake_reason" = NULLIF(run."context_snapshot" ->> 'wakeReason', ''),
        "context_wake_source" = NULLIF(run."context_snapshot" ->> 'wakeSource', ''),
        "context_wake_trigger_detail" = NULLIF(run."context_snapshot" ->> 'wakeTriggerDetail', ''),
        "context_run_summary" = left(
          COALESCE(
            NULLIF(run."context_snapshot" ->> 'taskTitle', ''),
            NULLIF(run."context_snapshot" -> 'executionContinuation' ->> 'objective', '')
          ),
          512
        )
      WHERE run."id" = ANY(ARRAY[${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}])
        AND run."context_issue_id" IS NULL
        AND run."context_task_id" IS NULL
        AND run."context_task_key" IS NULL
        AND run."context_comment_id" IS NULL
        AND run."context_wake_comment_id" IS NULL
        AND run."context_wake_reason" IS NULL
        AND run."context_wake_source" IS NULL
        AND run."context_wake_trigger_detail" IS NULL
        AND run."context_run_summary" IS NULL
        AND jsonb_typeof(run."context_snapshot") = 'object'
        AND jsonb_exists_any(run."context_snapshot", ARRAY[${keyList}]::text[])
      RETURNING run."id"
    `),
  );
  return {
    nextCursor: ids[ids.length - 1] ?? null,
    scanned: ids.length,
    updated: updated.length,
  };
}

/**
 * Walks `heartbeat_runs` by primary key until the end. Every batch is its
 * own committed statement; the loop yields for `pauseMs` between batches.
 */
export async function backfillRunContextColumns(
  db: Pick<Db, "execute">,
  options: RunContextBackfillOptions = {},
): Promise<RunContextBackfillResult> {
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? RUN_CONTEXT_BACKFILL_BATCH_SIZE));
  const pauseMs = Math.max(0, options.pauseMs ?? RUN_CONTEXT_BACKFILL_PAUSE_MS);
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const result: RunContextBackfillResult = { batches: 0, scanned: 0, updated: 0 };
  let cursor: string | null = null;
  for (;;) {
    if (options.signal?.aborted) break;
    const batch = await backfillRunContextColumnsBatch(db, cursor, batchSize);
    if (batch.scanned === 0) break;
    result.batches += 1;
    result.scanned += batch.scanned;
    result.updated += batch.updated;
    cursor = batch.nextCursor;
    if (batch.scanned < batchSize) break;
    if (pauseMs > 0) await sleep(pauseMs);
  }
  return result;
}

/**
 * Fire-and-forget starter for the server process. Failures are logged and
 * never reach startup: readers fall back to the snapshot for unfilled rows.
 */
export function startRunContextColumnsBackfill(
  db: Pick<Db, "execute">,
  log: {
    info(fields: object, message: string): void;
    warn(fields: object, message: string): void;
  },
): { stop(): void } {
  const controller = new AbortController();
  void backfillRunContextColumns(db, { signal: controller.signal })
    .then((result) => {
      if (result.updated > 0) log.info(result, "Backfilled thin heartbeat run context columns");
    })
    .catch((error) => {
      log.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "Run context columns backfill stopped; readers fall back to context_snapshot",
      );
    });
  return { stop: () => controller.abort() };
}
