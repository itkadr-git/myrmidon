import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  integer,
  bigint,
  boolean,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { agentWakeupRequests } from "./agent_wakeup_requests.js";

export const heartbeatRuns = pgTable(
  "heartbeat_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    invocationSource: text("invocation_source").notNull().default("on_demand"),
    triggerDetail: text("trigger_detail"),
    status: text("status").notNull().default("queued"),
    responsibleUserId: text("responsible_user_id"),
    // The service validates the company/run boundary; avoid a cyclic schema import.
    activeIdentityContextId: uuid("active_identity_context_id"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    // Set only after provider execution settles; never a timeout on thinking.
    executionControlDeadlineAt: timestamp("execution_control_deadline_at", { withTimezone: true }),
    // Transactional delivery marker. Null on historical rows; publication never replays provider work.
    executionStatusDeliveryId: uuid("execution_status_delivery_id"),
    error: text("error"),
    wakeupRequestId: uuid("wakeup_request_id").references(() => agentWakeupRequests.id),
    exitCode: integer("exit_code"),
    signal: text("signal"),
    usageJson: jsonb("usage_json").$type<Record<string, unknown>>(),
    resultJson: jsonb("result_json").$type<Record<string, unknown>>(),
    runtimeMode: text("runtime_mode").notNull().default("legacy"),
    runtimeModeResolverVersion: text("runtime_mode_resolver_version"),
    runtimeModeReason: text("runtime_mode_reason"),
    runtimeModeResolvedAt: timestamp("runtime_mode_resolved_at", { withTimezone: true }),
    runnerProfileJson: jsonb("runner_profile_json").$type<Record<string, unknown>>(),
    runnerInstanceId: uuid("runner_instance_id"),
    nativeSessionId: uuid("native_session_id"),
    nativeIssueId: uuid("native_issue_id"),
    driverKind: text("driver_kind"),
    driverVersion: text("driver_version"),
    completionContractId: uuid("completion_contract_id"),
    completionContractSha256: text("completion_contract_sha256"),
    nextEventSeq: bigint("next_event_seq", { mode: "number" }).notNull().default(1),
    nativePhase: text("native_phase"),
    nativePhaseUpdatedAt: timestamp("native_phase_updated_at", { withTimezone: true }),
    sessionIdBefore: text("session_id_before"),
    sessionIdAfter: text("session_id_after"),
    logStore: text("log_store"),
    logRef: text("log_ref"),
    logBytes: bigint("log_bytes", { mode: "number" }),
    logSha256: text("log_sha256"),
    logCompressed: boolean("log_compressed").notNull().default(false),
    stdoutExcerpt: text("stdout_excerpt"),
    stderrExcerpt: text("stderr_excerpt"),
    errorCode: text("error_code"),
    externalRunId: text("external_run_id"),
    // Legacy controller lease. A PID alone is not an identity across containers.
    controllerBootId: uuid("controller_boot_id"),
    controllerLeaseExpiresAt: timestamp("controller_lease_expires_at", { withTimezone: true }),
    executionStage: text("execution_stage"),
    processPid: integer("process_pid"),
    processGroupId: integer("process_group_id"),
    processStartedAt: timestamp("process_started_at", { withTimezone: true }),
    lastOutputAt: timestamp("last_output_at", { withTimezone: true }),
    lastOutputSeq: integer("last_output_seq").notNull().default(0),
    lastOutputStream: text("last_output_stream"),
    lastOutputBytes: bigint("last_output_bytes", { mode: "number" }),
    retryOfRunId: uuid("retry_of_run_id").references((): AnyPgColumn => heartbeatRuns.id, {
      onDelete: "set null",
    }),
    processLossRetryCount: integer("process_loss_retry_count").notNull().default(0),
    scheduledRetryAt: timestamp("scheduled_retry_at", { withTimezone: true }),
    scheduledRetryAttempt: integer("scheduled_retry_attempt").notNull().default(0),
    scheduledRetryReason: text("scheduled_retry_reason"),
    issueCommentStatus: text("issue_comment_status").notNull().default("not_applicable"),
    issueCommentSatisfiedByCommentId: uuid("issue_comment_satisfied_by_comment_id"),
    issueCommentRetryQueuedAt: timestamp("issue_comment_retry_queued_at", { withTimezone: true }),
    livenessState: text("liveness_state"),
    livenessReason: text("liveness_reason"),
    continuationAttempt: integer("continuation_attempt").notNull().default(0),
    lastUsefulActionAt: timestamp("last_useful_action_at", { withTimezone: true }),
    nextAction: text("next_action"),
    contextSnapshot: jsonb("context_snapshot").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    executionStatusDeliveryIdx: index("heartbeat_runs_execution_status_delivery_idx")
      .on(table.executionStatusDeliveryId).where(sql`${table.executionStatusDeliveryId} is not null`),
    executionControlDeadlineIdx: index("heartbeat_runs_execution_control_deadline_idx")
      .on(table.executionControlDeadlineAt).where(sql`${table.executionControlDeadlineAt} is not null`),
    nativeReplacementPredecessorUq: uniqueIndex("heartbeat_runs_native_replacement_predecessor_uq")
      .on(table.companyId, table.retryOfRunId)
      .where(sql`${table.scheduledRetryReason} = 'native_safe_replacement'`),
    companyNativeIssueRunUq: unique("heartbeat_runs_company_native_issue_id_uq").on(
      table.companyId,
      table.nativeIssueId,
      table.id,
    ),
    companyNativeIssueRunContractUq: unique(
      "heartbeat_runs_company_native_issue_contract_id_uq",
    ).on(
      table.companyId,
      table.nativeIssueId,
      table.id,
      table.completionContractId,
    ),
    companyAgentStartedIdx: index("heartbeat_runs_company_agent_started_idx").on(
      table.companyId,
      table.agentId,
      table.startedAt,
    ),
    companyResponsibleUserIdx: index("heartbeat_runs_company_responsible_user_idx").on(
      table.companyId,
      table.responsibleUserId,
      table.createdAt,
    ),
    companyLivenessIdx: index("heartbeat_runs_company_liveness_idx").on(
      table.companyId,
      table.livenessState,
      table.createdAt,
    ),
    companyStatusLastOutputIdx: index("heartbeat_runs_company_status_last_output_idx").on(
      table.companyId,
      table.status,
      table.lastOutputAt,
    ),
    companyStatusUpdatedAtIdx: index("heartbeat_runs_company_status_updated_idx").on(
      table.companyId,
      table.status,
      table.updatedAt,
    ),
    companyStatusProcessStartedIdx: index("heartbeat_runs_company_status_process_started_idx").on(
      table.companyId,
      table.status,
      table.processStartedAt,
    ),
    companyCreatedAtDescIdx: index("heartbeat_runs_company_created_at_desc_idx").on(
      table.companyId,
      table.createdAt.desc(),
    ),
    companyCtxIssueCreatedIdx: index("heartbeat_runs_company_ctx_issue_created_idx").on(
      table.companyId,
      sql`(${table.contextSnapshot} ->> 'issueId')`,
      table.createdAt.desc(),
    ),
    companyCtxTaskCreatedIdx: index("heartbeat_runs_company_ctx_task_created_idx").on(
      table.companyId,
      sql`(${table.contextSnapshot} ->> 'taskId')`,
      table.createdAt.desc(),
    ),
    companyCtxTaskKeyCreatedIdx: index("heartbeat_runs_company_ctx_taskkey_created_idx").on(
      table.companyId,
      sql`(${table.contextSnapshot} ->> 'taskKey')`,
      table.createdAt.desc(),
    ),
    // myrmidon(HEARTBEAT-POLL): driver index for the run-ownership probe
    // (server/src/services/conversation-continuation.ts,
    // getConversationOwnershipBlocker). That probe asks one question on every
    // wake: "does this task still have a terminal legacy run of a conversation
    // adapter that may own a process or an environment lease?". Its predicate is
    // company + runtime_mode + the run's issue reference
    // (native_issue_id, else context_snapshot->>'issueId') + four terminal
    // statuses, with an OR over JSON evidence and a correlated exists over the
    // run events. Only this index carries the issue reference and the
    // terminal-legacy filter together. See docs/myrmidon/DIVERGENCE.md.
    companyLegacyTerminalIssueIdx: index("heartbeat_runs_company_legacy_terminal_issue_idx").on(
      table.companyId,
      sql`(coalesce(${table.nativeIssueId}::text, ${table.contextSnapshot} ->> 'issueId'))`,
      table.createdAt.desc(),
      table.id.desc(),
    ).where(sql`${table.runtimeMode} = 'legacy' and ${table.status} in ('failed', 'timed_out', 'interrupted', 'cancelled')`),
    // myrmidon(DB-AUDIT-INDEXES): attention-feed lookup (server/src/services/
    // attention.ts) filters company + agent id + created_at window. The only
    // agent-keyed index is on started_at, so the planner scanned that index and
    // filtered created_at row by row. See the db audit, finding P3.
    companyAgentCreatedIdx: index("heartbeat_runs_company_agent_created_idx").on(
      table.companyId,
      table.agentId,
      table.createdAt,
    ),
    // myrmidon(DB-AUDIT-INDEXES): chat-reconcile milestone projection joins
    // context_snapshot->>'issueId' to chat conversations and filters status.
    // The 0209 sibling index orders by created_at and carries no status column,
    // so the join+status filter had no usable index. See the db audit, P5.
    companyCtxIssueStatusIdx: index("heartbeat_runs_ctx_issue_status_idx").on(
      table.companyId,
      sql`(${table.contextSnapshot} ->> 'issueId')`,
      table.status,
    ),
    // myrmidon(DB-CARE): the attention feed lists the runs of one agent inside a
    // created_at window and projects the issue and task ids out of the snapshot.
    // The agent-keyed index above orders by created_at but keeps neither
    // projection, so the feed fell back to a wider scan. Persisted from the
    // production database, see migration 0310_db_care_audit_indexes.
    attentionFeedIdx: index("heartbeat_runs_attention_feed_idx").on(
      table.companyId,
      table.agentId,
      table.createdAt,
      sql`(${table.contextSnapshot} ->> 'issueId')`,
      sql`(${table.contextSnapshot} ->> 'taskId')`,
    ),
    // myrmidon(DB-CARE): wake admission resolves the runs bound to one board
    // issue straight from context_snapshot->'paperclipIssue'->>'id', and the
    // index is partial on the rows that carry the key. Persisted from the
    // production database, see migration 0310_db_care_audit_indexes.
    ctxPaperclipIssueIdIdx: index("heartbeat_runs_ctx_paperclip_issue_id_idx")
      .on(
        table.companyId,
        sql`((${table.contextSnapshot} -> 'paperclipIssue') ->> 'id')`,
      )
      .where(sql`${table.contextSnapshot} ? 'paperclipIssue'`),
    // myrmidon(DB-CARE): the stuck-run sweeper scans the runs by updated_at,
    // which no other index serves. Persisted from the production database, see
    // migration 0310_db_care_audit_indexes.
    updatedAtIdx: index("heartbeat_runs_updated_at_idx").on(table.updatedAt),
    // myrmidon(DB-CARE / DBC-2): migration 0302_heartbeat_runs_company_issue_
    // coalesce_created_index already created this index before the Drizzle
    // declaration knew about it, so `pg_indexes` carried an object the schema
    // never named. The production copy was made by hand during OPE-4106 (three
    // columns - created_at DESC without id DESC); the managed definition below is
    // the four-column one that migration 0302 declared. Migration 0312 repeats
    // the CREATE so the statement chain and a fresh installation agree; on
    // production it is a no-op because the index name already exists. Aligning
    // the production copy with the four-column form is an operator rebuild
    // (DROP INDEX + CREATE INDEX CONCURRENTLY) and is recorded in
    // docs/myrmidon/changes/db-care-coalesce-index-declaration.md.
    companyIssueCoalesceCreatedIdx: index("heartbeat_runs_company_issue_coalesce_created_idx").on(
      table.companyId,
      sql`(coalesce(${table.nativeIssueId}::text, ${table.contextSnapshot} ->> 'issueId'))`,
      table.createdAt.desc(),
      table.id.desc(),
    ),
  }),
);
