// myrmidon(DB-PERF-C-P5): cheap "is there work" gates for the chat
// reconciliation coordinator (server/src/app.ts). See
// docs/myrmidon/changes/chat-reconcile-cheap-gate.md and
// docs/myrmidon/DIVERGENCE.md.
//
// The coordinator ticks once a second and used to run every durable lane on
// every tick, whether or not the lane had anything to do. On a
// production-shaped database the three heavy lanes (run-milestone projection,
// the publication flush, the delivery/message sweeps) took tens of
// milliseconds of CPU each per tick while their queues were almost always
// empty. Each gate below answers "is there anything for that lane to do"
// with ONE statement of the shape `select 1 where <probe> limit 1`, so an
// empty lane costs a single index probe instead of a full sweep.
//
// Two rules shape every probe:
//
//   1. Never under-report. A probe may answer "work" for a queue that turns
//      out to be empty (the lane then behaves exactly as it does today) but
//      it must not answer "no work" while the lane still has something to
//      do: that would delay a message. Where a lane's own selection is more
//      precise than the probe, the probe stays the broader one.
//   2. Lean on an existing index. The predicates below follow
//      `chat_publications_work_idx` (state, next_attempt_at),
//      `chat_deliveries_work_idx` (state, next_attempt_at),
//      `chat_actions_inbound_wakeup_sweep_idx` (kind, status, created_at, id),
//      `chat_publications_idempotency_uq` (company_id, idempotency_key) and
//      `heartbeat_runs_company_ctx_issue_created_idx`
//      (company_id, context_snapshot->>'issueId', created_at). No migration
//      ships with this module: the index set of the release it lands in is
//      the one the audit's index work (the DB-PERF A part) completes.

import {
  agentWakeupRequests,
  chatActions,
  chatConversations,
  chatDeliveries,
  chatEndpoints,
  chatPublications,
  heartbeatRuns,
  type Db,
} from "@paperclipai/db";
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

/** A `Db` narrowed to the one method a gate uses (a test seam). */
export type WorkGateDb = Pick<Db, "execute">;

export type WorkGateOptions = {
  /**
   * Optional company scope. The coordinator probes every company on the
   * instance (the lanes it gates are instance-wide); a company-scoped call
   * site can pass this to narrow the probe.
   */
  companyId?: string;
  /** Clock seam. Defaults to the wall clock. */
  now?: Date;
};

/**
 * States of `chat_publications` the publication flush is responsible for.
 * `pending`/`retry` are the durable outbox; a `streaming` row is the
 * in-flight one the same lane quarantines once it is stale (see
 * `processPendingPublications`), so it counts as work too.
 */
/** Rendered inline (never bound as a parameter) so the probe stays one
 * statically-shaped statement. */
const PUBLICATION_DUE_STATES = sql.raw("('pending', 'retry')");
const PUBLICATION_IN_FLIGHT_STATES = sql.raw("('streaming')");

/**
 * Statuses that mean "this `chat_actions` row still owes something", across
 * every kind the delivery lane drains. They are deliberately the union of
 * the per-sweep selections in `processPendingDeliveries` (inbound wakeups,
 * provider effects, receipt reactions, GitHub webhook ingress, Slack session
 * stops, Slack task starts, failed-run retries, Telegram maintenance): the
 * lane runs those sweeps together, so one row in any of them is work for the
 * whole lane. `failed` counts only while its own retry still says the row is
 * retryable, otherwise settled failures would keep the gate open forever.
 */
const DELIVERY_ACTION_KINDS = sql.raw(
  "('inbound_wakeup', 'provider_effect', 'receipt_reaction', 'github_webhook_ingress', 'slack_session_stop', 'slash_task_start', 'failed_run_retry', 'telegram_maintenance')",
);

const PENDING_ACTION_STATUSES = sql.raw(
  "('preparing', 'issued', 'received', 'processing', 'queued', 'provider_confirmed', 'admitting', 'resolving', 'validating')",
);

/**
 * Run statuses the run-milestone projection considers (the milestone set of
 * `enqueueChatRunMilestones`).
 */
const MILESTONE_RUN_STATUSES = sql.raw(
  "('queued', 'running', 'succeeded', 'interrupted', 'failed', 'timed_out', 'cancelled')",
);

const MILESTONE_OWNER_STATUSES = sql.raw(
  "('deferred_issue_execution', 'cancelled', 'failed', 'skipped')",
);

/**
 * One statement, one boolean. `select 1 where <probe> limit 1` returns a row
 * only when the probe holds, so the gate never materialises the queue it
 * asks about.
 */
async function probe(db: WorkGateDb, condition: SQL): Promise<boolean> {
  const rows = (await db.execute(
    sql`select 1 as probe where ${condition} limit 1`,
  )) as unknown as ArrayLike<unknown>;
  return rows.length > 0;
}

function companyScope(column: SQLWrapper, companyId: string | undefined): SQL {
  return companyId ? sql` and ${column} = ${companyId}` : sql``;
}

/**
 * The publication flush has work when the durable outbox holds a due row,
 * when a publication is stuck mid-flight (the lane quarantines stale
 * `streaming` rows), or when one of the two notice producers the same lane
 * runs has a settled wakeup whose notice publication is still missing
 * (`enqueueInboundWakeupPublications`, `enqueueFailedChatRetryPublications`).
 * Without that last branch a settled wakeup would wait for the next
 * publication write of any kind before its "queued"/"not started" notice
 * reached the chat.
 */
export function publicationWorkProbe(options: WorkGateOptions = {}): SQL {
  const now = options.now ?? new Date();
  const company = options.companyId;
  // The notice publication key is minted by the two producers:
  // `'wake:' || <owner> || ':' || <state> || ':' || endpoint || ':' || conversation`.
  // The owner is the wakeup row itself for a failed-run retry and the
  // coalesced owner for an inbound wakeup.
  const noticeOwner = sql`case
    when ${chatActions.kind} = 'failed_run_retry' then ${chatActions.id}::text
    else coalesce(
      ${agentWakeupRequests.payload} ->> 'coalescedIntoWakeupRequestId',
      ${agentWakeupRequests.id}::text
    )
  end`;
  const noticeState = sql`case
    when ${agentWakeupRequests.status} = 'deferred_issue_execution' then 'queued'
    else 'not_started'
  end`;
  const noticeSuffix = sql`':' || ${chatActions.endpointId}::text
    || ':' || ${chatActions.conversationId}::text`;
  const noticeKey = sql`'wake:' || ${noticeOwner} || ':' || ${noticeState} || ${noticeSuffix}`;
  const removedNoticeKey = sql`'wake:' || ${noticeOwner} || ':removed' || ${noticeSuffix}`;
  return sql`(
    exists (
      select 1
      from ${chatPublications}
      where ${chatPublications.state} in ${PUBLICATION_DUE_STATES}
        and (
          ${chatPublications.nextAttemptAt} is null
          or ${chatPublications.nextAttemptAt} <= ${now}
        )${companyScope(chatPublications.companyId, company)}
    )
    or exists (
      select 1
      from ${chatPublications}
      where ${chatPublications.state} in ${PUBLICATION_IN_FLIGHT_STATES}${companyScope(
        chatPublications.companyId,
        company,
      )}
    )
    or exists (
      select 1
      from ${chatActions}
      where ${chatActions.kind} = 'confirmation_response'
        and ${chatActions.status} = 'processing'${companyScope(
          chatActions.companyId,
          company,
        )}
    )
    or exists (
      select 1
      from ${chatActions}
      inner join ${agentWakeupRequests}
        on ${agentWakeupRequests.id} = ${chatActions.id}
        and ${agentWakeupRequests.companyId} = ${chatActions.companyId}
      where ${chatActions.kind} in ('inbound_wakeup', 'failed_run_retry')
        and ${chatActions.status} in ('processed', 'failed')
        and ${chatActions.conversationId} is not null
        and ${agentWakeupRequests.status} in ${MILESTONE_OWNER_STATUSES}
        and not exists (
          select 1
          from ${chatPublications}
          where ${chatPublications.companyId} = ${chatActions.companyId}
            and (
              ${chatPublications.idempotencyKey} = ${noticeKey}
              or (
                ${chatActions.kind} = 'inbound_wakeup'
                and ${chatPublications.idempotencyKey} = ${removedNoticeKey}
              )
            )
        )${companyScope(chatActions.companyId, company)}
    )
  )`;
}

/**
 * The delivery lane drains the verified-inbound outbox (`chat_deliveries`)
 * and every `chat_actions` outbox it reconciles on the way — provider
 * effects, receipt reactions, GitHub webhook ingress, Slack session stops,
 * Slack task starts, failed-run retries and Telegram maintenance. A row in
 * any of them means the lane runs; a `failed` action counts only while it is
 * still retryable.
 *
 * Not covered on purpose: the periodic Telegram endpoint state-repair staging
 * at the top of `processPendingTelegramMaintenance`. Its condition is a
 * runtime-derived scope (runtime generation, credential fingerprint, webhook
 * URL hash) that SQL cannot reproduce, and the same staging is also reached
 * from the endpoint lifecycle paths, so it keeps its cadence only while the
 * lane is open. See the PR's "Risks" note.
 */
export function deliveryWorkProbe(options: WorkGateOptions = {}): SQL {
  const company = options.companyId;
  return sql`(
    exists (
      select 1
      from ${chatDeliveries}
      where ${chatDeliveries.state} in ('received', 'retry', 'processing')${companyScope(
        chatDeliveries.companyId,
        company,
      )}
        and not exists (
          select 1
          from ${chatEndpoints}
          where ${chatEndpoints.id} = ${chatDeliveries.endpointId}
            and ${chatEndpoints.provider} = 'agentmail'
        )
    )
    or exists (
      select 1
      from ${chatActions}
      where ${chatActions.kind} in ${DELIVERY_ACTION_KINDS}
        and (
          ${chatActions.status} in ${PENDING_ACTION_STATUSES}
          or (
            ${chatActions.status} = 'failed'
            and ${chatActions.result} ->> 'retryable' = 'true'
          )
        )${companyScope(chatActions.companyId, company)}
    )
  )`;
}

/**
 * The Slack file-upload receipt recovery reads `chat_actions` rows of its own
 * kind; a settled failure counts only while it is retryable.
 */
export function slackFileReceiptWorkProbe(
  options: WorkGateOptions = {},
): SQL {
  return sql`(
    exists (
      select 1
      from ${chatActions}
      where ${chatActions.kind} = 'slack_file_upload_receipt'
        and (
          ${chatActions.status} in ('received', 'processing')
          or (
            ${chatActions.status} = 'failed'
            and ${chatActions.result} ->> 'retryable' = 'true'
          )
        )${companyScope(chatActions.companyId, options.companyId)}
    )
  )`;
}

/** The Slack session-sync lane reads `chat_actions` rows of its own kind. */
export function slackSessionSyncWorkProbe(options: WorkGateOptions = {}): SQL {
  return sql`(
    exists (
      select 1
      from ${chatActions}
      where ${chatActions.kind} = 'slack_session_sync'
        and ${chatActions.status} in ('received', 'processing')${companyScope(
          chatActions.companyId,
          options.companyId,
        )}
    )
  )`;
}

/**
 * A run-milestone candidate is a run the projection would consider: a status
 * from the milestone set, bound to a live chat conversation, updated after
 * the last pass this process completed. The probe walks the conversation
 * side (a small table) and lets `heartbeat_runs_company_ctx_issue_created_idx`
 * answer the run lookup per issue, which is the only index-backed access path
 * to runs of a chat on the current schema; on a production-shaped database
 * that is a few index probes per conversation instead of the projection's own
 * sweep.
 *
 * `since === null` means "no pass yet in this process" and the gate answers
 * "work" without a query at all, so the first tick after a start/restart is
 * always a full pass and nothing accumulated while the process was down is
 * lost.
 */
export function milestoneWorkProbe(input: {
  since: Date | null;
  companyId?: string;
}): SQL | null {
  if (input.since === null) return null;
  const company = input.companyId;
  return sql`(
    exists (
      select 1
      from ${chatConversations}
      inner join ${chatEndpoints}
        on ${chatEndpoints.companyId} = ${chatConversations.companyId}
        and ${chatEndpoints.id} = ${chatConversations.endpointId}
        and ${chatEndpoints.publicationMode} = 'automatic'
      where ${chatConversations.state} in ('active', 'waiting')
        and exists (
          select 1
          from ${heartbeatRuns}
          where ${heartbeatRuns.companyId} = ${chatConversations.companyId}
            and ${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${chatConversations.issueId}::text
            and ${heartbeatRuns.status} in ${MILESTONE_RUN_STATUSES}
            and ${heartbeatRuns.updatedAt} > ${input.since}
        )${companyScope(chatConversations.companyId, company)}
    )
  )`;
}

/**
 * The gates the coordinator asks before it starts a lane. Every method runs
 * one cheap statement; `hasMilestoneWork` additionally keeps the run-milestone
 * watermark in process memory (see `createChatReconciliationWorkGates`).
 */
export interface ChatReconciliationWorkGates {
  hasPublicationWork(): Promise<boolean>;
  hasDeliveryWork(): Promise<boolean>;
  hasSlackFileReceiptWork(): Promise<boolean>;
  hasSlackSessionSyncWork(): Promise<boolean>;
  hasMilestoneWork(): Promise<boolean>;
  /**
   * Records a completed run-milestone pass. `startedAt` is the moment the
   * pass began (taken before the projection ran) and `inserted` is what the
   * projection reported.
   *
   * The watermark only advances on a pass that inserted nothing. A pass that
   * inserted anything may have stopped at the projection's own row budget
   * with candidates still unprocessed, and those rows are older than the
   * watermark: advancing here would strand them. Leaving the watermark in
   * place costs one extra (empty) pass and cannot lose a milestone.
   */
  noteMilestonePassCompleted(startedAt: Date, inserted: number): void;
  /** Test seam: forget the run-milestone watermark. */
  resetMilestoneWatermark(): void;
}

/**
 * Default bound on how long the run-milestone gate may stay closed without a
 * pass. The probe's signal is "a chat-bound run changed", and a candidate can
 * in principle become eligible without that changing (a question delivery or
 * an interaction resolving later, a comment being removed): the projection's
 * own filter reads those tables too. One full pass per window keeps such a
 * row's delay bounded instead of leaving it to the next process restart,
 * while still replacing a per-second sweep with a handful of sweeps per hour.
 */
export const MILESTONE_WATERMARK_SAFETY_WINDOW_MS = 10 * 60_000;

export function createChatReconciliationWorkGates(input: {
  db: WorkGateDb;
  companyId?: string;
  now?: () => Date;
  /** Safety-window override (a test seam); see the constant above. */
  milestoneSafetyWindowMs?: number;
}): ChatReconciliationWorkGates {
  const now = input.now ?? (() => new Date());
  const safetyWindowMs =
    input.milestoneSafetyWindowMs ?? MILESTONE_WATERMARK_SAFETY_WINDOW_MS;
  let milestoneWatermark: Date | null = null;

  return {
    async hasPublicationWork() {
      return probe(
        input.db,
        publicationWorkProbe({ now: now(), companyId: input.companyId }),
      );
    },
    async hasDeliveryWork() {
      return probe(
        input.db,
        deliveryWorkProbe({ companyId: input.companyId }),
      );
    },
    async hasSlackFileReceiptWork() {
      return probe(
        input.db,
        slackFileReceiptWorkProbe({ companyId: input.companyId }),
      );
    },
    async hasSlackSessionSyncWork() {
      return probe(
        input.db,
        slackSessionSyncWorkProbe({ companyId: input.companyId }),
      );
    },
    async hasMilestoneWork() {
      if (
        milestoneWatermark === null ||
        now().getTime() - milestoneWatermark.getTime() >= safetyWindowMs
      )
        return true;
      const condition = milestoneWorkProbe({
        since: milestoneWatermark,
        companyId: input.companyId,
      });
      if (condition === null) return true;
      return probe(input.db, condition);
    },
    noteMilestonePassCompleted(startedAt, inserted) {
      if (inserted === 0) milestoneWatermark = startedAt;
    },
    resetMilestoneWatermark() {
      milestoneWatermark = null;
    },
  };
}

/** Standalone gate: the publication outbox, one statement. */
export function hasPublicationWork(
  db: WorkGateDb,
  options: WorkGateOptions = {},
): Promise<boolean> {
  return probe(db, publicationWorkProbe(options));
}

/** Standalone gate: the delivery lane's outboxes, one statement. */
export function hasDeliveryWork(
  db: WorkGateDb,
  options: WorkGateOptions = {},
): Promise<boolean> {
  return probe(db, deliveryWorkProbe(options));
}

/** Standalone gate: the Slack file-upload receipt outbox, one statement. */
export function hasSlackFileReceiptWork(
  db: WorkGateDb,
  options: WorkGateOptions = {},
): Promise<boolean> {
  return probe(db, slackFileReceiptWorkProbe(options));
}

/** Standalone gate: the Slack session-sync outbox, one statement. */
export function hasSlackSessionSyncWork(
  db: WorkGateDb,
  options: WorkGateOptions = {},
): Promise<boolean> {
  return probe(db, slackSessionSyncWorkProbe(options));
}

/**
 * Standalone gate: run-milestone candidates since `since`. `since === null`
 * answers `true` without touching the database (the first pass of a process).
 */
export async function hasRunMilestoneWork(
  db: WorkGateDb,
  input: { since: Date | null; companyId?: string },
): Promise<boolean> {
  const condition = milestoneWorkProbe(input);
  if (condition === null) return true;
  return probe(db, condition);
}