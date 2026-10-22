import type {
  ExecutionContinuationEnvelope,
  ExecutionContinuationWakeLinks,
} from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import { heartbeatRunContinuations, type Db } from "@paperclipai/db";

// myrmidon(RUN-SNAPSHOT-DEDUP): the execution continuation envelope is stored
// once per run snapshot. `context_snapshot.executionContinuation` is the
// canonical persisted copy; the structured wake payload carries a
// delivery-time copy only. Before this module the same ~90-100 KB envelope was
// written twice into every run snapshot (`executionContinuation` at the top
// level and again inside `paperclipWake`), which is the duplication the run
// audit measured. Adapting the envelope at dispatch keeps the adapter and the
// native-runner contract exactly as it was, because both read the wake payload.
//
// myrmidon(DB-CARE DBC-3): the canonical copy moved out of the snapshot
// altogether, into `heartbeat_run_continuations` (one row per run, capped by the
// character budget of continuation-history-limit.ts). The snapshot keeps the
// wake payload only, with the envelope referenced by run/comment ids
// (`wake_links`); readers fall back to the legacy snapshot copy, so runs written
// before the deployment resume unchanged.

export const EXECUTION_CONTINUATION_KEY = "executionContinuation";
export const PAPERCLIP_WAKE_PAYLOAD_KEY = "paperclipWake";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The wake payload as an adapter or the native runner must receive it.
 *
 * The persisted payload no longer carries its own copy of the continuation, so
 * dispatch re-attaches the run's canonical envelope here. Callers that persist
 * a snapshot must keep using the snapshot itself, never this projection.
 */
export function wakePayloadForDispatch(
  context: Record<string, unknown> | null | undefined,
): unknown {
  const snapshot = record(context);
  const wake = snapshot[PAPERCLIP_WAKE_PAYLOAD_KEY];
  if (wake === undefined || wake === null) return wake;

  const payload = record(wake);
  const continuation = snapshot[EXECUTION_CONTINUATION_KEY];
  const hasContinuation = continuation !== undefined && continuation !== null;
  const carried = Object.prototype.hasOwnProperty.call(
    payload,
    EXECUTION_CONTINUATION_KEY,
  );
  // Nothing to attach and nothing stale to drop: hand the stored payload over
  // unchanged so the context a single-run test handed in stays identical.
  if (!hasContinuation && !carried) return wake;

  const { [EXECUTION_CONTINUATION_KEY]: _stale, ...rest } = payload;
  return hasContinuation
    ? { ...rest, [EXECUTION_CONTINUATION_KEY]: continuation }
    : rest;
}

/**
 * Drop the nested continuation copy from a run snapshot bound for a response.
 *
 * Legacy rows still hold both copies. Only a byte-identical duplicate of the
 * surviving top-level envelope is removed, so the response loses no
 * information: a payload that differs from the canonical copy is left alone.
 * This is the response-side half of the same single-copy invariant.
 */
export function withoutDuplicateExecutionContinuation<T>(value: T): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const snapshot = value as Record<string, unknown>;
  const continuation = snapshot[EXECUTION_CONTINUATION_KEY];
  if (continuation === undefined || continuation === null) return value;

  const wake = record(snapshot[PAPERCLIP_WAKE_PAYLOAD_KEY]);
  if (!Object.prototype.hasOwnProperty.call(wake, EXECUTION_CONTINUATION_KEY)) {
    return value;
  }
  const carried = wake[EXECUTION_CONTINUATION_KEY];
  if (carried === undefined || carried === null) {
    const { [EXECUTION_CONTINUATION_KEY]: _empty, ...rest } = wake;
    return { ...snapshot, [PAPERCLIP_WAKE_PAYLOAD_KEY]: rest } as T;
  }
  if (JSON.stringify(carried) !== JSON.stringify(continuation)) return value;

  const { [EXECUTION_CONTINUATION_KEY]: _duplicate, ...rest } = wake;
  return { ...snapshot, [PAPERCLIP_WAKE_PAYLOAD_KEY]: rest } as T;
}

/**
 * myrmidon(DB-CARE DBC-3): a run snapshot bound for the database.
 *
 * The envelope lives in `heartbeat_run_continuations` now, so persistence drops
 * the top-level copy instead of storing it a second time. The in-memory context
 * keeps the key: dispatch and the prompt still read it from there.
 */
export function runContextForPersistence<T extends Record<string, unknown>>(context: T): T {
  const snapshot = record(context);
  if (!Object.prototype.hasOwnProperty.call(snapshot, EXECUTION_CONTINUATION_KEY)) return context;
  const { [EXECUTION_CONTINUATION_KEY]: _moved, ...rest } = snapshot;
  return rest as T;
}

export interface RunContinuationPersistInput {
  companyId: string;
  agentId: string;
  issueId: string | null;
  runId: string;
  previousContextRunId: string | null;
  envelope: ExecutionContinuationEnvelope;
  wakeLinks?: ExecutionContinuationWakeLinks | null;
}

/**
 * Stores the envelope of a run, one row per run (upsert on `run_id`).
 *
 * Returns false when the write failed. Resume must not hinge on this: the wake
 * of the run in progress already carries the envelope in memory, and readers
 * fall back to the legacy snapshot copy, so a failed write degrades to the old
 * behaviour instead of stopping the run. The failure is still logged loudly
 * because the next wake's delta would be built from an outdated envelope.
 */
export async function persistRunContinuation(
  db: Db,
  input: RunContinuationPersistInput,
): Promise<boolean> {
  const chars = JSON.stringify(input.envelope).length;
  const values = {
    companyId: input.companyId,
    agentId: input.agentId,
    issueId: input.issueId,
    runId: input.runId,
    previousContextRunId: input.previousContextRunId,
    envelope: input.envelope,
    envelopeChars: chars,
    wakeLinks: input.wakeLinks ?? null,
  };
  try {
    await db
      .insert(heartbeatRunContinuations)
      .values(values)
      .onConflictDoUpdate({
        target: heartbeatRunContinuations.runId,
        set: { ...values, updatedAt: new Date() },
      });
    return true;
  } catch (error) {
    console.error(
      `[run-continuation] could not persist the continuation of run ${input.runId}; ` +
        "resume falls back to the run snapshot",
      error,
    );
    return false;
  }
}

/**
 * Reads the envelope of a run: the continuation row first, the legacy
 * `context_snapshot` copy second (rows written before DB-CARE DBC-3 and rows
 * whose continuation write failed).
 */
export async function loadRunContinuationEnvelope(
  db: Db,
  input: { companyId: string; runId: string; legacyContext?: unknown },
): Promise<ExecutionContinuationEnvelope | null> {
  let stored: unknown;
  try {
    const [row] = await db
      .select({ envelope: heartbeatRunContinuations.envelope })
      .from(heartbeatRunContinuations)
      .where(
        and(
          eq(heartbeatRunContinuations.companyId, input.companyId),
          eq(heartbeatRunContinuations.runId, input.runId),
        ),
      )
      .limit(1);
    stored = row?.envelope;
  } catch (error) {
    console.warn(
      `[run-continuation] continuation lookup failed for run ${input.runId}; ` +
        "using the run snapshot",
      error,
    );
  }
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    return stored as ExecutionContinuationEnvelope;
  }
  const legacy = record(input.legacyContext)[EXECUTION_CONTINUATION_KEY];
  return legacy && typeof legacy === "object" && !Array.isArray(legacy)
    ? (legacy as ExecutionContinuationEnvelope)
    : null;
}