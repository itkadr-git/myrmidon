// myrmidon(N4-RUN-LIVENESS): progress-event liveness for hermes_gateway runs.
//
// The vendor watchdog is a fixed wall-clock timer started when execute()
// begins: a run still emitting gateway events past its timeoutSec is cut off
// exactly like one whose stream died. Behind MYRMIDON_RUN_LIVENESS_EVENTS
// (default off) the timer is replaced by a liveness check: every
// LIVENESS_CHECK_INTERVAL_MS the watch compares now with the stamp of the
// newest gateway event (handleEvent touches the stamp for every SSE frame);
// only a run whose silence already exceeds timeoutSec is reported stalled. A
// run with fresh events is left alone for another interval, no matter how long
// it has been running overall.
//
// Everything here is pure or injected; the wiring lives in execute.ts.

export const RUN_LIVENESS_EVENTS_ENV = "MYRMIDON_RUN_LIVENESS_EVENTS";

/**
 * Spacing between two silence checks. Short enough that a truly stalled run is
 * caught close to its budget; long enough that the timer churn stays invisible
 * next to the per-second status poll the adapter already runs.
 */
export const LIVENESS_CHECK_INTERVAL_MS = 30_000;

export interface RunLivenessState {
  /** Date.now() of the newest gateway event seen for this run. */
  lastEventAtMs: number;
}

export function touchRunLiveness(state: RunLivenessState, now: number = Date.now()): void {
  state.lastEventAtMs = now;
}

/**
 * Master switch. Opt-in (default off): only an explicit truthy value or a
 * truthy adapterConfig.livenessEvents enables event-based liveness; unset,
 * `0`/`false`/`off`/`no` or a typo keep the vendor's fixed timeout. The
 * adapter config wins over the environment when set.
 */
export function resolveRunLivenessEvents(
  configValue: unknown,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (configValue !== undefined && configValue !== null) {
    if (configValue === true) return true;
    if (typeof configValue === "string") {
      const normalized = configValue.trim().toLowerCase();
      return normalized === "1" || normalized === "true" || normalized === "on" || normalized === "yes";
    }
    return false;
  }
  const raw = env[RUN_LIVENESS_EVENTS_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

/**
 * Arms the liveness watch. Returns a disposer that stops the timer; the
 * callback fires at most once, the first time the observed silence reaches
 * timeoutMs. A run with no events at all still times out exactly when the
 * vendor timer would have fired.
 */
export function installRunLivenessWatch(input: {
  state: RunLivenessState;
  timeoutMs: number;
  onStalled: () => void;
  now?: () => number;
  checkIntervalMs?: number;
}): () => void {
  const now = input.now ?? Date.now;
  const intervalMs = Math.max(
    1_000,
    Math.min(input.checkIntervalMs ?? LIVENESS_CHECK_INTERVAL_MS, input.timeoutMs),
  );
  let fired = false;
  const check = () => {
    if (fired) return;
    if (now() - input.state.lastEventAtMs >= input.timeoutMs) {
      fired = true;
      input.onStalled();
      return;
    }
    timer = setTimeout(check, intervalMs);
    timer.unref?.();
  };
  let timer = setTimeout(check, intervalMs);
  timer.unref?.();
  return () => {
    fired = true;
    clearTimeout(timer);
  };
}
