// server/src/myrmidon/auth-401-burst/index.ts
// myrmidon(OPE-11890): public surface of the 401-burst detector. The error
// handler calls recordAuth401; that increments the sliding-window counter and,
// when the window crosses the threshold, latches the detector and records the
// attention signal in one step — callers never touch the latch directly.

import { auth401BurstMetrics, type Auth401Reason } from "./metrics.js";
import { recordAuth401BurstSignal } from "./attention.js";

/**
 * Record one authentication 401. `reason` is the closed-set classification the
 * auth middleware already computed (req.actorNoneReason); anything else
 * collapses to "unknown" inside the counter. The Authorization header / token
 * is never passed here and never logged.
 */
export function recordAuth401(reason: unknown, atMs?: number): void {
  auth401BurstMetrics.record(reason, atMs);
  // After every record, mirror the latch into the attention registry. This is
  // cheap (one boolean check when untripped) and keeps the card and the
  // Prometheus family in lock-step with the same threshold/window.
  recordAuth401BurstSignal(auth401BurstMetrics.read(atMs));
}

export {
  AUTH_401_REASONS,
  auth401BurstMetrics,
  readAuth401BurstSettings,
  type Auth401BurstSample,
  type Auth401Reason,
} from "./metrics.js";
export {
  readAuth401BurstSignal,
  resetAuth401BurstSignal,
  auth401BurstSignalDedupKey,
  auth401BurstSignalWhyNow,
  auth401BurstSignalSeverity,
  type Auth401BurstSignal,
} from "./attention.js";
