// server/src/myrmidon/data-retention/sweep.ts
//
// myrmidon(1.6.5-DB-RETENTION): the retention sweep of runs and logs.
//
// One pass per scheduler tick, internally paced: every table group deletes in
// batches of 5000 rows, at most 100 batches per table per pass (the
// plugin-log-retention precedent), so a pass stays short even over GB-sized
// tables and a first full cleanup takes many ticks by design.
//
// Groups and their rules:
//
//   - `runs` (heartbeatRunsDays): heartbeat_runs rows older than the cutoff
//     that are FINISHED — a run with `finished_at` set is always finished,
//     otherwise the status decides (`queued`/`scheduled_retry`/`running` are
//     the live statuses, from HEARTBEAT_RUN_STATUSES in @paperclipai/shared)
//     — and not referenced by open work: not the execution/checkout run of a
//     non-terminal issue, not the retry parent of a live run, and not the
//     source of an unresolved failed_run attention item (the feed derives
//     that item straight from heartbeat_runs, so the run row itself must
//     stay while no newer run exists for the same agent+issue pair and no
//     dismissal covers it — the exclusion mirrors exactly the feed's
//     derivation in server/src/services/attention.ts). The run's
//     heartbeat_run_events rows go first (the FK has no cascade), then the
//     run row; the sweep transaction also nulls the plain (non-cascading,
//     non-set-null) FK references into heartbeat_runs (cost_events,
//     finance_events, decisions, decision_bundles, decision_queues,
//     agent_task_sessions, document_annotation_comments) so the delete
//     cannot trip a foreign key.
//   - `activity` (activityLogDays): activity_log rows older than the cutoff,
//     except rows whose runId points at a run that survives — the audit
//     trail of a kept run stays complete.
//   - `access` (accessAuditDays): tool_access_audit_events and
//     secret_access_events rows older than the cutoff (no dependencies).
//
// A retention of 0 means "keep forever": the group is skipped. Before the
// first destructive statement of a pass the backup gate runs (a fresh
// `<prefix>-*.sql.gz` in the resolved backup dir); when it fails, the pass
// deletes nothing, writes one throttled `data.retention_waiting_for_backup`
// activity line and reports waitingForBackup in the persisted state.
//
// Stats persist across restarts in
// `instance_settings.general.dataRetention.lastRun`; the freed-bytes figure
// is the sum of `pg_column_size(id)` over the deleted rows — a documented
// lower bound (indexes, TOAST and payload columns are not counted; the real
// table size settles after autovacuum).

import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  HEARTBEAT_RUN_STATUSES,
  emptyDataRetentionLastRun,
  type DataRetentionLastRun,
  type DataRetentionSettings,
  type DataRetentionTableStatus,
} from "@paperclipai/shared";

/** Rows per delete batch (the plugin-log-retention precedent). */
export const DATA_RETENTION_DELETE_BATCH_SIZE = 5_000;

/** Batches per table per pass; the rest waits for the next tick. */
export const DATA_RETENTION_MAX_BATCHES = 100;

/** The statement timeout the sweep transactions run under. */
export const DATA_RETENTION_STATEMENT_TIMEOUT_MS = 60_000;

/** The live (non-terminal) heartbeat run statuses, from the codebase list. */
export const DATA_RETENTION_LIVE_RUN_STATUSES = HEARTBEAT_RUN_STATUSES.filter(
  (status) => status === "queued" || status === "scheduled_retry" || status === "running",
);

/** The unsuccessful terminal statuses the failed_run attention feed reads. */
const FAILED_RUN_ATTENTION_STATUSES = ["failed", "timed_out"];

/** The terminal issue statuses; anything else keeps its run references alive. */
const TERMINAL_ISSUE_STATUSES = ["done", "cancelled"];

export interface DataRetentionSweepDeps {
  db: Db;
  /** Re-read at the top of every pass, so a settings PATCH needs no restart. */
  resolveSettings: () => Promise<DataRetentionSettings>;
  readLastRun: () => Promise<DataRetentionLastRun>;
  writeLastRun: (lastRun: DataRetentionLastRun) => Promise<void>;
  /** The backup gate; fresh=true lets the pass delete. */
  checkBackup: () => Promise<{ fresh: boolean; checkedAt: Date }>;
  /** The throttled "waiting for backup" activity line. */
  logWaitingForBackup: (details: Record<string, unknown>) => Promise<void>;
  now?: () => Date;
}

export interface DataRetentionSweepResult {
  startedAt: Date;
  finishedAt: Date;
  waitingForBackup: boolean;
  perTable: Record<"runs" | "activity" | "access", { deleted: number; freedBytes: number }>;
}

interface DeletedRow {
  id: string;
  size: number;
}

function cutoffFor(now: Date, days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function isDeleteBlockedError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return code === "57014" /* query_canceled: statement_timeout */ || code === "55P03";
}

export function createDataRetentionSweep(deps: DataRetentionSweepDeps) {
  const now = deps.now ?? (() => new Date());
  let inFlight: Promise<DataRetentionSweepResult> | null = null;

  async function deleteRunsGroup(
    tx: Db,
    cutoff: string,
  ): Promise<{ deleted: number; freedBytes: number }> {
    const liveStatuses = sql.join(
      DATA_RETENTION_LIVE_RUN_STATUSES.map((status) => sql`${status}`),
      sql`, `,
    );
    const failedStatuses = sql.join(
      FAILED_RUN_ATTENTION_STATUSES.map((status) => sql`${status}`),
      sql`, `,
    );
    const terminalIssueStatuses = sql.join(
      TERMINAL_ISSUE_STATUSES.map((status) => sql`${status}`),
      sql`, `,
    );
    let deleted = 0;
    let freedBytes = 0;
    for (let batch = 0; batch < DATA_RETENTION_MAX_BATCHES; batch++) {
      const rows = await tx.execute(sql`
        WITH doomed AS (
          SELECT r.id
          FROM heartbeat_runs r
          WHERE r.created_at < ${cutoff}
            AND (
              r.finished_at IS NOT NULL
              OR r.status NOT IN (${liveStatuses})
            )
            -- not the execution/checkout run of an issue with open work
            AND NOT EXISTS (
              SELECT 1 FROM issues i
              WHERE (i.execution_run_id = r.id OR i.checkout_run_id = r.id)
                AND i.status NOT IN (${terminalIssueStatuses})
            )
            -- not the retry parent of a live run
            AND NOT EXISTS (
              SELECT 1 FROM heartbeat_runs child
              WHERE child.retry_of_run_id = r.id
                AND child.finished_at IS NULL
                AND child.status IN (${liveStatuses})
            )
            -- not the source of an unresolved failed_run attention item: the
            -- feed derives the item from the run row itself (see
            -- server/src/services/attention.ts), so the row stays while it
            -- is failed/timed_out, no newer run exists for the same
            -- agent+issue pair, and no dismissal covers the item
            AND NOT (
              r.status IN (${failedStatuses})
              AND NOT EXISTS (
                SELECT 1 FROM heartbeat_runs newer
                WHERE newer.agent_id = r.agent_id
                  AND newer.id <> r.id
                  AND newer.created_at > r.created_at
                  AND COALESCE(
                    newer.context_snapshot ->> 'issueId',
                    newer.context_snapshot ->> 'taskId',
                    ''
                  ) = COALESCE(
                    r.context_snapshot ->> 'issueId',
                    r.context_snapshot ->> 'taskId',
                    ''
                  )
              )
              AND NOT EXISTS (
                SELECT 1 FROM inbox_dismissals d
                WHERE d.company_id = r.company_id
                  AND d.item_key = ${`attention:run:`}::text || r.id::text
                  AND d.dismissed_at >= COALESCE(r.finished_at, r.updated_at, r.created_at)
              )
            )
          ORDER BY r.created_at
          LIMIT ${DATA_RETENTION_DELETE_BATCH_SIZE}
        ),
        -- plain (non-cascading, non-set-null) references into heartbeat_runs
        -- must let go first; the FKs otherwise refuse the delete
        null_cost_events AS (
          UPDATE cost_events ce SET heartbeat_run_id = NULL
          WHERE ce.heartbeat_run_id IN (SELECT id FROM doomed)
        ),
        null_finance_events AS (
          UPDATE finance_events fe SET heartbeat_run_id = NULL
          WHERE fe.heartbeat_run_id IN (SELECT id FROM doomed)
        ),
        null_decisions AS (
          UPDATE decisions d SET origin_run_id = NULL
          WHERE d.origin_run_id IN (SELECT id FROM doomed)
        ),
        null_decision_bundles AS (
          UPDATE decision_bundles db SET origin_run_id = NULL
          WHERE db.origin_run_id IN (SELECT id FROM doomed)
        ),
        null_decision_queues AS (
          UPDATE decision_queues dq SET created_by_run_id = NULL
          WHERE dq.created_by_run_id IN (SELECT id FROM doomed)
        ),
        null_agent_task_sessions AS (
          UPDATE agent_task_sessions ats SET last_run_id = NULL
          WHERE ats.last_run_id IN (SELECT id FROM doomed)
        ),
        null_annotation_comments AS (
          UPDATE document_annotation_comments dac SET created_by_run_id = NULL
          WHERE dac.created_by_run_id IN (SELECT id FROM doomed)
        ),
        -- the audit trail goes with the run: activity_log.run_id has no
        -- cascade and no set-null, so the doomed run's activity rows are
        -- deleted here regardless of the activity retention (the surviving
        -- runs' trail stays complete — the activity group skips them)
        del_run_activity AS (
          DELETE FROM activity_log al WHERE al.run_id IN (SELECT id FROM doomed)
        ),
        del_events AS (
          DELETE FROM heartbeat_run_events e WHERE e.run_id IN (SELECT id FROM doomed)
        ),
        del_runs AS (
          DELETE FROM heartbeat_runs r
          WHERE r.id IN (SELECT id FROM doomed)
          RETURNING r.id, pg_column_size(r.id) AS size
        )
        SELECT id, size FROM del_runs
      `);
      const batchRows = rows as unknown as DeletedRow[];
      deleted += batchRows.length;
      for (const row of batchRows) freedBytes += Number(row.size) || 0;
      if (batchRows.length < DATA_RETENTION_DELETE_BATCH_SIZE) break;
    }
    return { deleted, freedBytes };
  }

  async function deleteActivityGroup(
    tx: Db,
    cutoff: string,
  ): Promise<{ deleted: number; freedBytes: number }> {
    let deleted = 0;
    let freedBytes = 0;
    for (let batch = 0; batch < DATA_RETENTION_MAX_BATCHES; batch++) {
      const rows = await tx.execute(sql`
        DELETE FROM activity_log a
        WHERE a.id IN (
          SELECT a2.id FROM activity_log a2
          WHERE a2.created_at < ${cutoff}
            -- the audit trail of a surviving run stays complete
            AND (a2.run_id IS NULL OR NOT EXISTS (
              SELECT 1 FROM heartbeat_runs r WHERE r.id = a2.run_id
            ))
          ORDER BY a2.created_at
          LIMIT ${DATA_RETENTION_DELETE_BATCH_SIZE}
        )
        RETURNING a.id, pg_column_size(a.id) AS size
      `);
      const batchRows = rows as unknown as DeletedRow[];
      deleted += batchRows.length;
      for (const row of batchRows) freedBytes += Number(row.size) || 0;
      if (batchRows.length < DATA_RETENTION_DELETE_BATCH_SIZE) break;
    }
    return { deleted, freedBytes };
  }

  async function deleteAccessGroup(
    tx: Db,
    cutoff: string,
  ): Promise<{ deleted: number; freedBytes: number }> {
    let deleted = 0;
    let freedBytes = 0;
    for (const table of ["tool_access_audit_events", "secret_access_events"] as const) {
      const tableSql = sql.raw(table);
      for (let batch = 0; batch < DATA_RETENTION_MAX_BATCHES; batch++) {
        const rows = await tx.execute(sql`
          DELETE FROM ${tableSql} t
          WHERE t.id IN (
            SELECT t2.id FROM ${tableSql} t2
            WHERE t2.created_at < ${cutoff}
            ORDER BY t2.created_at
            LIMIT ${DATA_RETENTION_DELETE_BATCH_SIZE}
          )
          RETURNING t.id, pg_column_size(t.id) AS size
        `);
        const batchRows = rows as unknown as DeletedRow[];
        deleted += batchRows.length;
        for (const row of batchRows) freedBytes += Number(row.size) || 0;
        if (batchRows.length < DATA_RETENTION_DELETE_BATCH_SIZE) break;
      }
    }
    return { deleted, freedBytes };
  }

  function mergeTableStatus(
    previous: DataRetentionTableStatus,
    pass: { deleted: number; freedBytes: number },
  ): DataRetentionTableStatus {
    return {
      deletedTotal: previous.deletedTotal + pass.deleted,
      lastDeleted: pass.deleted,
      lastFreedBytes: pass.freedBytes,
    };
  }

  async function pass(): Promise<DataRetentionSweepResult> {
    const startedAt = now();
    const settings = await deps.resolveSettings();
    const previous = await deps.readLastRun();

    // The backup gate guards the first destructive statement of the pass and
    // is re-checked every pass; it lifts as soon as a fresh backup appears.
    const gate = await deps.checkBackup();
    if (!gate.fresh) {
      await deps.logWaitingForBackup({
        checkedAt: gate.checkedAt.toISOString(),
        settings,
      });
      const lastRun: DataRetentionLastRun = {
        ...previous,
        lastRunAt: startedAt.toISOString(),
        waitingForBackup: true,
        backupCheckedAt: gate.checkedAt.toISOString(),
      };
      await deps.writeLastRun(lastRun);
      return {
        startedAt,
        finishedAt: now(),
        waitingForBackup: true,
        perTable: {
          runs: { deleted: 0, freedBytes: 0 },
          activity: { deleted: 0, freedBytes: 0 },
          access: { deleted: 0, freedBytes: 0 },
        },
      };
    }

    const results: DataRetentionSweepResult["perTable"] = {
      runs: { deleted: 0, freedBytes: 0 },
      activity: { deleted: 0, freedBytes: 0 },
      access: { deleted: 0, freedBytes: 0 },
    };

    const groups: Array<{
      key: "runs" | "activity" | "access";
      days: number;
      run: (tx: Db, cutoff: string) => Promise<{ deleted: number; freedBytes: number }>;
    }> = [
      { key: "runs", days: settings.heartbeatRunsDays, run: deleteRunsGroup },
      { key: "activity", days: settings.activityLogDays, run: deleteActivityGroup },
      { key: "access", days: settings.accessAuditDays, run: deleteAccessGroup },
    ];

    for (const group of groups) {
      if (group.days === 0) continue; // 0 = keep forever
      const cutoff = cutoffFor(startedAt, group.days);
      try {
        results[group.key] = await deps.db.transaction(async (tx) => {
          await tx.execute(
            // SET does not accept bind parameters; the timeout is a module constant.
            sql.raw(
              `SET LOCAL statement_timeout = ${DATA_RETENTION_STATEMENT_TIMEOUT_MS}`,
            ),
          );
          return group.run(tx as unknown as Db, cutoff);
        });
      } catch (err) {
        if (isDeleteBlockedError(err)) {
          // A pathological batch gave up its locks; the next pass retries.
          continue;
        }
        throw err;
      }
    }

    const lastRun: DataRetentionLastRun = {
      lastRunAt: startedAt.toISOString(),
      waitingForBackup: false,
      backupCheckedAt: gate.checkedAt.toISOString(),
      freedBytesTotal:
        previous.freedBytesTotal +
        results.runs.freedBytes +
        results.activity.freedBytes +
        results.access.freedBytes,
      perTable: {
        runs: mergeTableStatus(previous.perTable.runs, results.runs),
        activity: mergeTableStatus(previous.perTable.activity, results.activity),
        access: mergeTableStatus(previous.perTable.access, results.access),
      },
    };
    await deps.writeLastRun(lastRun);
    return {
      startedAt,
      finishedAt: now(),
      waitingForBackup: false,
      perTable: results,
    };
  }

  return {
    /** One sweep pass; a concurrent call joins the pass already running. */
    sweep: (): Promise<DataRetentionSweepResult> => {
      if (!inFlight) {
        inFlight = pass().finally(() => {
          inFlight = null;
        });
      }
      return inFlight;
    },
    /** The empty state, exported for tests and the service fallback. */
    emptyLastRun: emptyDataRetentionLastRun,
  };
}

export type DataRetentionSweep = ReturnType<typeof createDataRetentionSweep>;
