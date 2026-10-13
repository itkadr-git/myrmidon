// myrmidon(RUN-SNAPSHOT-DEDUP): the execution continuation envelope is stored
// once per run snapshot. `context_snapshot.executionContinuation` is the
// canonical persisted copy; the structured wake payload carries a
// delivery-time copy only. Before this module the same ~90-100 KB envelope was
// written twice into every run snapshot (`executionContinuation` at the top
// level and again inside `paperclipWake`), which is the duplication the run
// audit measured. Adapting the envelope at dispatch keeps the adapter and the
// native-runner contract exactly as it was, because both read the wake payload.

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