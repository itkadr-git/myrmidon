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
//     derivation in server/src/services/attention.ts).
//
//   Every column in packages/db/src/schema/*.ts that references
//   heartbeat_runs is classified below and handled in the runs-group
//   transaction, in dependency order (children first):
//
//   DELETE with the run (the row has no meaning without it):
//     - heartbeat_run_events (NOT NULL run_id, no action)
//
//   KEEP — a run referenced by any of these tables is never deleted
//   (operator review dbcare-review-20261008: decision-making and native
//   completion records outlive the run), enforced as NOT EXISTS clauses
//   on the doomed set:
//     - decisions / decision_bundles (NOT NULL origin_run_id, no action —
//       a null UPDATE would raise 23502)
//     - status_decisions / work_assessments / native_run_results (NOT NULL
//       run_id) — and status_decision_effects / native_run_finalizations
//       ride along: an effect's decision or a finalization's run is kept,
//       so the chain keeps the run too.
//
//   activity_log rows of the doomed runs are never deleted: the activity
//   log is the audit trail and is kept regardless of the run's fate. The
//   FK has no action, so the reference is cleared (run_id is nullable)
//   instead of the row going with the run.
//
//   NULL before the delete (nullable column, no action in the schema):
//     - cost_events.heartbeat_run_id, finance_events.heartbeat_run_id,
//       agent_task_sessions.last_run_id,
//       document_annotation_comments.created_by_run_id,
//       activity_log.run_id (the activity rows themselves are never
//       deleted — the log is the audit trail and outlives the run)
//     - the five run columns of the decision-queue family, one per table:
//       decision_queues.created_by_run_id,
//       decision_queue_items.added_by_run_id, decision_triage.set_by_run_id,
//       decision_triage_events.actor_run_id,
//       decision_retention.archived_by_run_id
//
//   KEEP, no statement needed (the FK action clears the reference):
//     every column declared with { onDelete: "cascade" } or
//     { onDelete: "set null" } — heartbeat_run_watchdog_decisions,
//     tool_access.run_id (cascade), company_secret_proposals,
//     provider_trace_records (cascade), document_revisions,
//     environment_leases, execution_workspace_runtime_leases,
//     issue_attachments, issue_claims, issue_comments,
//     issue_execution_decisions, issue_inbox_archives,
//     issue_plan_decompositions, issue_question_response_deliveries,
//     issue_thread_interactions, issue_tree_hold_members,
//     issue_tree_holds, issue_watchdogs, issue_work_products,
//     issues.checkout_run_id / execution_run_id, routines,
//     secret_access_events, status_cards, workspace_operations,
//     workspace_runtime_services, heartbeat_runs.retry_of_run_id
//     (self, set null).
//
//   - `activity` (activityLogDays): activity_log rows older than the cutoff,
//     except rows whose runId points at a run that survives — the audit
//     trail of a kept run stays complete. The default is 0 (keep forever):
//     the activity log is the audit trail and is not aged out unless the
//     instance admin opts in.
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
// `instance_settings.general.datastoreCare.retention.lastRun`; the
// freed-bytes figure is the sum of `pg_column_size(id)` over the deleted
// rows — a documented lower bound (indexes, TOAST and payload columns are
// not counted; the real table size settles after autovacuum).

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

/**
 * The sweep runs at most one pass per this window (operator review
 * dbcare-review-20261008): the 30 s scheduler tick calls sweep() every
 * time, but a tick inside the window of the previous pass is a no-op and
 * touches neither the database nor the persisted state.
 */
export const DATA_RETENTION_SWEEP_MIN_INTERVAL_MS = 10 * 60 * 1000;

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
  /**
   * One journal line per group whose batch hit the statement timeout or
   * failed to take its locks — a swallowed timeout is invisible in the
   * audit trail otherwise.
   */
  logThrottled: (details: Record<string, unknown>) => Promise<void>;
  /**
   * Test hook: overrides the pass throttle
   * (DATA_RETENTION_SWEEP_MIN_INTERVAL_MS by default; 0 runs every call).
   */
  minPassIntervalMs?: number;
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
  const minPassIntervalMs =
    deps.minPassIntervalMs ?? DATA_RETENTION_SWEEP_MIN_INTERVAL_MS;
  let inFlight: Promise<DataRetentionSweepResult> | null = null;
  // Throttle anchor of the sweep pass (DATA_RETENTION_SWEEP_MIN_INTERVAL_MS).
  // The pass itself resets the anchor, so a pass that outlives the window
  // never throttles the next tick.
  let lastPassStartedAtMs: number | null = null;

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
    // one batch per call — the caller wraps each batch in its own transaction
    let deleted = 0;
    let freedBytes = 0;
    {
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
            -- operator review dbcare-review-20261008: a run referenced by
            -- any decision-making or native completion record is never
            -- deleted — those records outlive the run
            AND NOT EXISTS (
              SELECT 1 FROM decisions d WHERE d.origin_run_id = r.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM decision_bundles db WHERE db.origin_run_id = r.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM status_decisions sd WHERE sd.run_id = r.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM work_assessments wa WHERE wa.run_id = r.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM native_run_results nr WHERE nr.run_id = r.id
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
        -- every run column the decision-queue family declares (one per
        -- table): decision_queues.created_by_run_id,
        -- decision_queue_items.added_by_run_id,
        -- decision_triage.set_by_run_id,
        -- decision_triage_events.actor_run_id,
        -- decision_retention.archived_by_run_id
        null_decision_queues AS (
          UPDATE decision_queues dq SET created_by_run_id = NULL
          WHERE dq.created_by_run_id IN (SELECT id FROM doomed)
        ),
        null_decision_queue_items AS (
          UPDATE decision_queue_items dqi SET added_by_run_id = NULL
          WHERE dqi.added_by_run_id IN (SELECT id FROM doomed)
        ),
        null_decision_triage AS (
          UPDATE decision_triage dt SET set_by_run_id = NULL
          WHERE dt.set_by_run_id IN (SELECT id FROM doomed)
        ),
        null_decision_triage_events AS (
          UPDATE decision_triage_events dte SET actor_run_id = NULL
          WHERE dte.actor_run_id IN (SELECT id FROM doomed)
        ),
        null_decision_retention AS (
          UPDATE decision_retention dr SET archived_by_run_id = NULL
          WHERE dr.archived_by_run_id IN (SELECT id FROM doomed)
        ),
        null_agent_task_sessions AS (
          UPDATE agent_task_sessions ats SET last_run_id = NULL
          WHERE ats.last_run_id IN (SELECT id FROM doomed)
        ),
        null_annotation_comments AS (
          UPDATE document_annotation_comments dac SET created_by_run_id = NULL
          WHERE dac.created_by_run_id IN (SELECT id FROM doomed)
        ),
        -- the audit trail outlives the run: activity_log rows are never
        -- deleted (activityLogDays defaults to 0 = keep forever), so the
        -- reference is cleared instead of the row going with the run
        null_run_activity AS (
          UPDATE activity_log al SET run_id = NULL
          WHERE al.run_id IN (SELECT id FROM doomed)
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
    }
    return { deleted, freedBytes };
  }

  async function deleteActivityGroup(
    tx: Db,
    cutoff: string,
  ): Promise<{ deleted: number; freedBytes: number }> {
    // one batch per call — the caller wraps each batch in its own transaction
    let deleted = 0;
    let freedBytes = 0;
    {
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
    }
    return { deleted, freedBytes };
  }

  async function deleteAccessGroup(
    tx: Db,
    cutoff: string,
  ): Promise<{ deleted: number; freedBytes: number }> {
    // one batch per table per call — the caller wraps each batch in its own
    // transaction
    let deleted = 0;
    let freedBytes = 0;
    for (const table of ["tool_access_audit_events", "secret_access_events"] as const) {
      const tableSql = sql.raw(table);
      {
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

  type GroupKey = "runs" | "activity" | "access";

  async function runGroup(
    group: { key: GroupKey; days: number },
    cutoff: string,
  ): Promise<{ deleted: number; freedBytes: number }> {
    const run =
      group.key === "runs"
        ? deleteRunsGroup
        : group.key === "activity"
          ? deleteActivityGroup
          : deleteAccessGroup;
    let deleted = 0;
    let freedBytes = 0;
    for (let batch = 0; batch < DATA_RETENTION_MAX_BATCHES; batch++) {
      let batchResult: { deleted: number; freedBytes: number };
      try {
        // Every batch is its own transaction (operator review
        // dbcare-review-20261008): a failed batch rolls back only itself,
        // the work of the previous batches of the pass stands.
        batchResult = await deps.db.transaction(async (tx) => {
          await tx.execute(
            // SET does not accept bind parameters; the timeout is a module constant.
            sql.raw(
              `SET LOCAL statement_timeout = ${DATA_RETENTION_STATEMENT_TIMEOUT_MS}`,
            ),
          );
          return run(tx as unknown as Db, cutoff);
        });
      } catch (err) {
        if (isDeleteBlockedError(err)) {
          // A batch hit the statement timeout (57014) or gave up its locks:
          // the rest of the group waits for the next pass, and the stop
          // goes into the journal — a swallowed timeout is invisible in
          // the audit trail otherwise.
          await deps
            .logThrottled({
              group: group.key,
              batch,
              errorCode: (err as { code?: unknown } | null | undefined)?.code ?? null,
              cutoff,
            })
            .catch(() => undefined);
          break;
        }
        throw err;
      }
      deleted += batchResult.deleted;
      freedBytes += batchResult.freedBytes;
      if (batchResult.deleted < DATA_RETENTION_DELETE_BATCH_SIZE) break;
    }
    return { deleted, freedBytes };
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
      // lastRunAt stays: the pass ran but did no work. The state is
      // re-written only when the gate flag changes — writing it on every
      // idle tick flooded the general jsonb (operator review
      // dbcare-review-20261008, ~2880 writes/day).
      if (!previous.waitingForBackup) {
        await deps.writeLastRun({
          ...previous,
          waitingForBackup: true,
          backupCheckedAt: gate.checkedAt.toISOString(),
        });
      }
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

    const groups: Array<{ key: GroupKey; days: number }> = [
      { key: "runs", days: settings.heartbeatRunsDays },
      { key: "activity", days: settings.activityLogDays },
      { key: "access", days: settings.accessAuditDays },
    ];

    for (const group of groups) {
      if (group.days === 0) continue; // 0 = keep forever
      const cutoff = cutoffFor(startedAt, group.days);
      results[group.key] = await runGroup(group, cutoff);
    }

    const didWork =
      results.runs.deleted > 0 ||
      results.activity.deleted > 0 ||
      results.access.deleted > 0;
    // The state is written only when the pass actually deleted something or
    // the backup-gate flag changes — not on every idle tick (operator review
    // dbcare-review-20261008).
    if (didWork || previous.waitingForBackup) {
      const lastRun: DataRetentionLastRun = {
        ...previous,
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
    }
    return {
      startedAt,
      finishedAt: now(),
      waitingForBackup: false,
      perTable: results,
    };
  }

  return {
    /**
     * One sweep pass; a concurrent call joins the pass already running, and
     * a call inside DATA_RETENTION_SWEEP_MIN_INTERVAL_MS of the previous
     * pass is a no-op (operator review dbcare-review-20261008: at most one
     * pass per 10 minutes, the 30 s scheduler tick no-ops in between).
     */
    sweep: (): Promise<DataRetentionSweepResult> => {
      if (!inFlight) {
        const nowMs = now().getTime();
        if (
          lastPassStartedAtMs !== null &&
          nowMs - lastPassStartedAtMs < minPassIntervalMs
        ) {
          return Promise.resolve({
            startedAt: new Date(nowMs),
            finishedAt: new Date(nowMs),
            waitingForBackup: false,
            perTable: {
              runs: { deleted: 0, freedBytes: 0 },
              activity: { deleted: 0, freedBytes: 0 },
              access: { deleted: 0, freedBytes: 0 },
            },
          });
        }
        lastPassStartedAtMs = nowMs;
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
