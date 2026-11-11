// server/src/myrmidon/gateway-run-close.ts
//
// myrmidon(HERMES-GATEWAY-CLOSE, OPE-11889): close the remote hermes gateway
// run of a heartbeat run that the board has finished with.
//
// The incident (07.11): bot gateways answered "Too many concurrent runs
// (max 8)" because their slots were still held by runs the board already
// considered finished. Until now the board stopped a gateway run in exactly one
// place, an operator cancellation of an unsupervised run (cancelRunInternal).
// A run that the board ended any other way -- a board-side timeout (the
// execution-control deadline), a stale / process_lost / run_stall reap, an
// adapter failure that left the remote run alive -- kept its slot until the
// gateway's own timeout swept it.
//
// This module is the ledger and the sweep of that close:
//
//   * ONCE. A close is claimed under the run row lock and recorded as run
//     events (gateway_remote_close_requested / _done / _failed). The events are
//     append-only, so unlike resultJson (rewritten wholesale by several status
//     writers) they cannot be lost between the claim and the terminal write. A
//     run whose close is done is never closed again, whichever path asks.
//   * PROVENANCE. Every event carries who closed the run and why: the
//     cancellation provenance of an operator cancel, or the terminal cause of the
//     run (board timeout / stale / completion) with the run's own correlation id.
//     The same provenance goes to the gateway as x-paperclip-* headers.
//   * SAFE RETRY. Only the remote RUN is stopped, never the Hermes session: the
//     session (sessionParams.hermesSessionId) is what lets the retry of the run
//     continue the same conversation, and it does not occupy a run slot. A failed
//     or unreachable close is retried a bounded number of times, probe first: a
//     run the gateway already finished (or forgot) is recorded as already closed
//     and is never stopped.
//   * EVERY PATH. The heartbeat service calls the close from its central status
//     writers (setRunStatus / setRunStatusFromLive) and from the execution-control
//     reconciliation. The sweep below is the durable net under all the other
//     writers (recovery, native finalization, direct updates) and under a crash
//     between a terminal write and its close.

import { and, asc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { agents, heartbeatRunEvents, heartbeatRuns, type Db } from "@myrmidon/db";
import { logger } from "../middleware/logger.js";
import { appendHeartbeatRunEvent } from "../services/heartbeat-run-events.js";

export const GATEWAY_REMOTE_CLOSE_REQUESTED_EVENT = "gateway_remote_close_requested";
export const GATEWAY_REMOTE_CLOSE_DONE_EVENT = "gateway_remote_close_done";
export const GATEWAY_REMOTE_CLOSE_FAILED_EVENT = "gateway_remote_close_failed";

/** Attempts per run (a request without a result counts as an attempt). */
export const GATEWAY_REMOTE_CLOSE_MAX_ATTEMPTS = 3;
/** Minimum gap before a failed (or never-answered) close is attempted again. */
export const GATEWAY_REMOTE_CLOSE_RETRY_DELAY_MS = 5 * 60_000;
/** Cadence of the periodic sweep. */
export const GATEWAY_REMOTE_CLOSE_SWEEP_INTERVAL_MS = 60_000;
/** Only runs that changed within this window are swept; older slots are the gateway's own business. */
export const GATEWAY_REMOTE_CLOSE_LOOKBACK_MS = 2 * 60 * 60_000;
export const GATEWAY_REMOTE_CLOSE_SWEEP_BATCH = 50;
/** One sweep pass never holds the scheduler tick longer than this. */
export const GATEWAY_REMOTE_CLOSE_SWEEP_BUDGET_MS = 20_000;
const GATEWAY_REMOTE_CLOSE_SWEEP_CONCURRENCY = 4;

const LEDGER_EVENT_TYPES = [
  GATEWAY_REMOTE_CLOSE_REQUESTED_EVENT,
  GATEWAY_REMOTE_CLOSE_DONE_EVENT,
  GATEWAY_REMOTE_CLOSE_FAILED_EVENT,
];
const TERMINAL_RUN_STATUSES = ["succeeded", "interrupted", "failed", "cancelled", "timed_out"];

export type GatewayRemoteCloseTrigger = "cancel" | "terminal" | "sweep";

export interface GatewayRemoteCloseProvenance {
  correlationId: string;
  source: { code: string; endpoint?: string; actor?: string };
  reason: string;
}

/**
 * stopped: the gateway accepted POST /stop for a live run.
 * already_closed: the gateway reports the run finished or unknown; nothing to free.
 * stop_failed / unreachable: nothing is confirmed; retried (bounded).
 */
export type GatewayRemoteCloseOutcome = "stopped" | "already_closed" | "stop_failed" | "unreachable";

export type GatewayRemoteCloseClaim =
  | { claimed: true; attempt: number }
  | {
      claimed: false;
      reason: "run_missing" | "already_closed" | "attempts_exhausted" | "in_flight" | "retry_not_due";
    };

export type GatewayRemoteCloseResult =
  | { outcome: GatewayRemoteCloseOutcome; attempt: number }
  | { outcome: "skipped"; reason: string };

type RunRef = { id: string; companyId: string; agentId: string };

function boundedText(value: string, max = 500): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * Who closed the gateway run and why, for a run the board ended without an
 * operator cancellation. The correlation id continues the one the board
 * stamped on the run's cancellation when there is one.
 */
export function deriveTerminalCloseProvenance(
  run: {
    id: string;
    status: string;
    errorCode?: string | null;
    /** resultJson.executionCancellation fields, when the board stamped one. */
    cancellationCorrelationId?: string | null;
    cancellationSource?: { code: string; endpoint?: string; actor?: string } | null;
    cancellationReason?: string | null;
  },
  newCorrelationId: () => string,
): GatewayRemoteCloseProvenance {
  const errorCode = run.errorCode ?? "";
  const recorded = run.cancellationCorrelationId || null;
  let code = "terminal_completion";
  if (run.status === "timed_out" || /timeout|deadline/i.test(errorCode)) code = "board_timeout";
  else if (/stall|stale|lost/i.test(errorCode)) code = "board_stale";
  else if (run.status === "cancelled") code = run.cancellationSource?.code ?? "board_cancelled";
  const cause = errorCode ? ` (${errorCode})` : "";
  return {
    correlationId: recorded ?? newCorrelationId(),
    source: run.cancellationSource ?? { code, actor: "board" },
    reason: boundedText(run.cancellationReason ?? `Heartbeat run ${run.id} ended ${run.status}${cause} on the board`),
  };
}

function provenancePayload(provenance: GatewayRemoteCloseProvenance) {
  return {
    correlationId: provenance.correlationId,
    source: provenance.source,
    reason: boundedText(provenance.reason),
  };
}

/**
 * Claim the (next) close attempt of one run. Serialized by the run row lock,
 * which appendHeartbeatRunEvent takes as well. Returns claimed:false when the
 * close is done, still in flight, exhausted, or not yet due for a retry.
 */
export async function claimGatewayRemoteClose(
  db: Db,
  input: {
    run: RunRef & { status: string; externalRunId: string };
    trigger: GatewayRemoteCloseTrigger;
    provenance: GatewayRemoteCloseProvenance;
    now?: Date;
  },
): Promise<GatewayRemoteCloseClaim> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('statement_timeout', '10000', true), set_config('lock_timeout', '3000', true)`,
    );
    const [locked] = await tx
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, input.run.id))
      .for("update");
    if (!locked) return { claimed: false as const, reason: "run_missing" as const };
    const ledger = await tx
      .select({
        eventType: heartbeatRunEvents.eventType,
        createdAt: heartbeatRunEvents.createdAt,
      })
      .from(heartbeatRunEvents)
      .where(
        and(
          eq(heartbeatRunEvents.runId, input.run.id),
          inArray(heartbeatRunEvents.eventType, LEDGER_EVENT_TYPES),
        ),
      )
      .orderBy(asc(heartbeatRunEvents.id));
    if (ledger.some((event) => event.eventType === GATEWAY_REMOTE_CLOSE_DONE_EVENT)) {
      return { claimed: false as const, reason: "already_closed" as const };
    }
    const attempts = ledger.filter(
      (event) => event.eventType === GATEWAY_REMOTE_CLOSE_REQUESTED_EVENT,
    ).length;
    if (attempts >= GATEWAY_REMOTE_CLOSE_MAX_ATTEMPTS) {
      return { claimed: false as const, reason: "attempts_exhausted" as const };
    }
    const last = ledger[ledger.length - 1];
    if (last) {
      const ageMs = now.getTime() - new Date(last.createdAt).getTime();
      if (ageMs < GATEWAY_REMOTE_CLOSE_RETRY_DELAY_MS) {
        // A request without a result is another worker mid-flight; a failure is
        // waiting out its retry delay. Neither is repeated blindly.
        return {
          claimed: false as const,
          reason:
            last.eventType === GATEWAY_REMOTE_CLOSE_REQUESTED_EVENT
              ? ("in_flight" as const)
              : ("retry_not_due" as const),
        };
      }
    }
    const attempt = attempts + 1;
    await appendHeartbeatRunEvent(tx as unknown as Db, {
      companyId: input.run.companyId,
      runId: input.run.id,
      agentId: input.run.agentId,
      eventType: GATEWAY_REMOTE_CLOSE_REQUESTED_EVENT,
      stream: "system",
      level: "info",
      message: `Closing hermes gateway run ${input.run.externalRunId} (attempt ${attempt}, ${input.trigger})`,
      payload: {
        attempt,
        trigger: input.trigger,
        gatewayRunId: input.run.externalRunId,
        runStatus: input.run.status,
        ...provenancePayload(input.provenance),
      },
    });
    return { claimed: true as const, attempt };
  });
}

/** Record the verdict of a claimed close attempt. */
export async function recordGatewayRemoteCloseResult(
  db: Db,
  input: {
    run: RunRef & { externalRunId: string };
    attempt: number;
    trigger: GatewayRemoteCloseTrigger;
    outcome: GatewayRemoteCloseOutcome;
    provenance: GatewayRemoteCloseProvenance;
    detail?: string | null;
  },
): Promise<void> {
  const closed = input.outcome === "stopped" || input.outcome === "already_closed";
  await appendHeartbeatRunEvent(db, {
    companyId: input.run.companyId,
    runId: input.run.id,
    agentId: input.run.agentId,
    eventType: closed ? GATEWAY_REMOTE_CLOSE_DONE_EVENT : GATEWAY_REMOTE_CLOSE_FAILED_EVENT,
    stream: "system",
    level: closed ? "info" : "warn",
    message:
      input.outcome === "stopped"
        ? `Hermes gateway run ${input.run.externalRunId} stopped by the board`
        : input.outcome === "already_closed"
          ? `Hermes gateway run ${input.run.externalRunId} already finished on the gateway`
          : `Hermes gateway run ${input.run.externalRunId} could not be closed (${input.outcome})`,
    payload: {
      attempt: input.attempt,
      trigger: input.trigger,
      outcome: input.outcome,
      gatewayRunId: input.run.externalRunId,
      ...(input.detail ? { detail: boundedText(input.detail, 300) } : {}),
      ...provenancePayload(input.provenance),
    },
  });
}

export interface GatewayRemoteClosePort {
  closeTerminalGatewayRun: (runId: string) => Promise<unknown>;
}

/**
 * Close the gateway runs of terminal hermes_gateway heartbeat runs that no
 * status writer closed (recovery paths, direct updates, a crash between the
 * terminal write and its close) or whose close failed and is due for a retry.
 */
export async function sweepTerminalGatewayRunCloses(
  db: Db,
  port: GatewayRemoteClosePort,
  opts: { now?: Date; lookbackMs?: number; limit?: number; budgetMs?: number } = {},
): Promise<{ scanned: number; attempted: number; failed: number }> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - (opts.lookbackMs ?? GATEWAY_REMOTE_CLOSE_LOOKBACK_MS));
  const retryCutoff = new Date(now.getTime() - GATEWAY_REMOTE_CLOSE_RETRY_DELAY_MS);
  const candidates = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
    .where(
      and(
        inArray(heartbeatRuns.status, TERMINAL_RUN_STATUSES),
        isNotNull(heartbeatRuns.externalRunId),
        eq(agents.adapterType, "hermes_gateway"),
        gte(heartbeatRuns.updatedAt, since),
        sql`not exists (
          select 1 from ${heartbeatRunEvents} e
          where e.run_id = ${heartbeatRuns.id}
            and e.event_type = ${GATEWAY_REMOTE_CLOSE_DONE_EVENT}
        )`,
        sql`(
          select count(*) from ${heartbeatRunEvents} e
          where e.run_id = ${heartbeatRuns.id}
            and e.event_type = ${GATEWAY_REMOTE_CLOSE_REQUESTED_EVENT}
        ) < ${GATEWAY_REMOTE_CLOSE_MAX_ATTEMPTS}`,
        sql`not exists (
          select 1 from ${heartbeatRunEvents} e
          where e.run_id = ${heartbeatRuns.id}
            and e.event_type in (${GATEWAY_REMOTE_CLOSE_REQUESTED_EVENT}, ${GATEWAY_REMOTE_CLOSE_FAILED_EVENT})
            and e.created_at > ${retryCutoff.toISOString()}::timestamptz
        )`,
      ),
    )
    .orderBy(asc(heartbeatRuns.updatedAt))
    .limit(opts.limit ?? GATEWAY_REMOTE_CLOSE_SWEEP_BATCH);

  const deadline = Date.now() + (opts.budgetMs ?? GATEWAY_REMOTE_CLOSE_SWEEP_BUDGET_MS);
  let next = 0;
  let attempted = 0;
  let failed = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(GATEWAY_REMOTE_CLOSE_SWEEP_CONCURRENCY, candidates.length) },
      async () => {
        while (next < candidates.length && Date.now() < deadline) {
          const candidate = candidates[next++]!;
          attempted += 1;
          try {
            await port.closeTerminalGatewayRun(candidate.id);
          } catch (err) {
            failed += 1;
            logger.warn(
              { err, runId: candidate.id },
              "terminal gateway run close failed; the next pass retries within its bounded attempts",
            );
          }
        }
      },
    ),
  );
  return { scanned: candidates.length, attempted, failed };
}
