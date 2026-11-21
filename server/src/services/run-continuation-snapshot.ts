import type {
  ExecutionContinuationEnvelope,
  ExecutionContinuationWakeLinks,
} from "@myrmidon/shared";
import { and, eq } from "drizzle-orm";
import { heartbeatRunContinuations, type Db } from "@myrmidon/db";
import { isDeepStrictEqual } from "node:util";
import type { PullRequestCiResult } from "./github-pull-request-ci.js";

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
export const WAKE_CI_PROJECTION_KEY = "wakeCiProjectionV1";
const EVENT_DIGEST_REFERENCE = "eventDigestFromSnapshot";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sameJson(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(JSON.parse(JSON.stringify(left)), JSON.parse(JSON.stringify(right)));
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

type CiTails = NonNullable<PullRequestCiResult["ciFailureTails"]>;

function compactCiTails(tails: CiTails, budget: number): CiTails {
  if (jsonBytes(tails) <= budget) return tails;
  return tails.slice(0, 3).map(({ jobId, jobName, runId, logTail, unavailableReason }) => ({
    jobId, jobName: Array.from(jobName).slice(0, 100).join(""), runId,
    logTail: logTail ? `[log tail truncated]\n${Array.from(logTail).slice(-Math.floor(budget / 40)).join("")}` : logTail,
    unavailableReason: unavailableReason ? Array.from(unavailableReason).slice(0, 100).join("") : unavailableReason,
  }));
}

function compactCi(ci: PullRequestCiResult) {
  const { runs, failedJobs, optionalFailedJobs, cancelledJobs, ciFailureTails, ...verdict } = ci;
  const details = { runs, failedJobs, optionalFailedJobs, cancelledJobs, ciFailureTails };
  if (jsonBytes(details) <= 4_000) return ci;
  const keep = <T>(jobs: T[] | undefined) => jobs && jsonBytes(jobs) <= 750 ? jobs : jobs && [];
  return {
    ...verdict,
    runs: keep(runs) ?? [], failedJobs: keep(failedJobs) ?? [],
    optionalFailedJobs: keep(optionalFailedJobs), cancelledJobs: keep(cancelledJobs),
    ciFailureTails: ciFailureTails && compactCiTails(ciFailureTails, 1_600),
    detailsTruncated: true,
    checksUrl: githubChecksUrl(ci),
  };
}

function githubChecksUrl(ci: PullRequestCiResult): string | undefined {
  if (!/^[\w.-]+\/[\w.-]+$/.test(ci.repository) || !Number.isSafeInteger(ci.pullNumber)) return;
  return `https://github.com/${ci.repository}/pull/${ci.pullNumber}/checks`;
}

function compactDigest(value: unknown): unknown {
  const digest = record(value);
  // The database guard measures characters, not bytes. Cyrillic and emoji
  // should not lose payload just because their UTF-8 encoding is longer.
  if (!Array.isArray(digest.events) || Array.from(JSON.stringify(digest)).length <= 45_000) return value;
  return {
    ...digest,
    events: digest.events.map((event) => {
      const { payload, ...header } = record(event);
      if (!payload || Array.from(JSON.stringify(payload)).length <= 1_000) return event;
      const { issueId, commentId, runId, mutation } = record(payload);
      const link = (v: unknown) => typeof v === "string" && v.length <= 128 ? v : undefined;
      return { ...header, payload: { issueId: link(issueId), commentId: link(commentId), runId: link(runId), mutation: link(mutation), truncated: true } };
    }),
  };
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

  const stored = record(wake);
  let payload = stored;
  if (stored[EVENT_DIGEST_REFERENCE] === true) {
    const { [EVENT_DIGEST_REFERENCE]: _reference, ...rest } = stored;
    payload = { ...rest, eventDigest: snapshot.eventDigest ?? null };
  }
  if (snapshot[WAKE_CI_PROJECTION_KEY] === true && !Object.hasOwn(payload, "ciResult") && Array.isArray(payload.pullRequestsCi)) {
    payload = { ...payload, ciResult: payload.pullRequestsCi[0] ?? null };
  }
  const continuation = snapshot[EXECUTION_CONTINUATION_KEY];
  const hasContinuation = continuation !== undefined && continuation !== null;
  const carried = Object.prototype.hasOwnProperty.call(
    payload,
    EXECUTION_CONTINUATION_KEY,
  );
  // Nothing to attach and nothing stale to drop: hand the stored payload over
  // unchanged so the context a single-run test handed in stays identical.
  if (!hasContinuation && !carried) return payload === stored ? wake : payload;

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
  const { [EXECUTION_CONTINUATION_KEY]: _moved, ...snapshot }: Record<string, unknown> = context;
  const rawWake = snapshot[PAPERCLIP_WAKE_PAYLOAD_KEY];
  const topDigest = snapshot.eventDigest;
  if (topDigest != null) snapshot.eventDigest = compactDigest(topDigest);
  if (!rawWake || typeof rawWake !== "object" || Array.isArray(rawWake)) return snapshot as T;
  const wake = { ...record(rawWake) };
  if (wake.eventDigest != null) {
    // Compare the already-redacted wake digest before applying the size cap.
    if (topDigest != null && sameJson(topDigest, wake.eventDigest)) {
      delete wake.eventDigest;
      wake[EVENT_DIGEST_REFERENCE] = true;
    } else {
      wake.eventDigest = compactDigest(wake.eventDigest);
    }
  }
  if (snapshot[WAKE_CI_PROJECTION_KEY] === true && Array.isArray(wake.pullRequestsCi)) {
    if (!Object.hasOwn(wake, "ciResult") || sameJson(wake.ciResult ?? null, wake.pullRequestsCi[0] ?? null)) {
      delete wake.ciResult;
    } else if (wake.ciResult != null) {
      wake.ciResult = compactCi(wake.ciResult as PullRequestCiResult);
    }
    wake.pullRequestsCi = (wake.pullRequestsCi as PullRequestCiResult[]).map(compactCi);
    if (Array.isArray(wake.ciFailureTails) && jsonBytes(wake.ciFailureTails) > 12_000) {
      wake.ciFailureTails = compactCiTails(wake.ciFailureTails as CiTails, 12_000);
      wake.ciFailureTailsTruncated = true;
    }
  }
  return { ...snapshot, [PAPERCLIP_WAKE_PAYLOAD_KEY]: wake } as T;
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