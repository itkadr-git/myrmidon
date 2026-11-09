// server/src/myrmidon/auth-401-burst/metrics.ts
// myrmidon(OPE-11890): the product-side replacement for the host
// paperclip-auth-401-watch timer. The detector lives in-process next to the
// other in-process counters (guardrails/metrics.ts) and counts every 401 the
// error handler emits, bucketed into a fixed-width sliding window. When the
// per-window count crosses the burst threshold the detector latches a `tripped`
// flag; the flag is what the board-signal registry (attention.ts) and the
// Prometheus family (monitoring/metrics) read.
//
// The contract this module pins for CI:
//  * threshold and window are read from env, with bounded defaults, and the
//    same values drive both the counter and the latch — no two code paths can
//    disagree about what a burst is;
//  * only the closed reason set becomes a label — the raw Authorization header,
//    token, or key NEVER enters the counter, the latch, or any log line here.
//
// Reason labels are the bounded AUTH_401_REASONS set, mirroring the
// req.actorNoneReason taxonomy the auth middleware already classifies
// (server/src/middleware/auth.ts); anything outside the set collapses to
// "unknown" so an attacker-controlled detail can never mint a new
// high-cardinality label. "public_path_bypass" is excluded on purpose — a
// public path is not an auth rejection and never reaches the 401 path.

export const AUTH_401_REASONS = [
  "no_credentials",
  "session_resolution_error",
  "session_invalid",
  "agent_token_expired",
  "agent_token_invalid",
  "agent_token_agent_mismatch",
  "agent_token_agent_terminated",
  "agent_token_agent_pending",
  "agent_key_agent_mismatch",
  "agent_key_agent_terminated",
  "agent_key_agent_pending",
  "unknown",
] as const;
export type Auth401Reason = (typeof AUTH_401_REASONS)[number];

export const AUTH_401_BURST_THRESHOLD_ENV = "MYRMIDON_AUTH_401_BURST_THRESHOLD";
export const AUTH_401_BURST_WINDOW_SEC_ENV = "MYRMIDON_AUTH_401_BURST_WINDOW_SEC";

export const DEFAULT_AUTH_401_BURST_THRESHOLD = 20;
export const DEFAULT_AUTH_401_BURST_WINDOW_SEC = 60;

function validReason(value: unknown): value is Auth401Reason {
  return typeof value === "string" && (AUTH_401_REASONS as readonly string[]).includes(value);
}

export interface Auth401BurstSettings {
  /** 401s per window that trip the burst latch. */
  threshold: number;
  /** Sliding-window width, milliseconds. */
  windowMs: number;
}

export function readAuth401BurstSettings(env: NodeJS.ProcessEnv = process.env): Auth401BurstSettings {
  const thresholdRaw = Number(env[AUTH_401_BURST_THRESHOLD_ENV]?.trim() || DEFAULT_AUTH_401_BURST_THRESHOLD);
  const windowSecRaw = Number(env[AUTH_401_BURST_WINDOW_SEC_ENV]?.trim() || DEFAULT_AUTH_401_BURST_WINDOW_SEC);
  const threshold =
    Number.isInteger(thresholdRaw) && thresholdRaw > 0
      ? Math.min(thresholdRaw, 100_000)
      : DEFAULT_AUTH_401_BURST_THRESHOLD;
  const windowMs =
    Number.isFinite(windowSecRaw) && windowSecRaw > 0
      ? Math.min(windowSecRaw, 3_600) * 1000
      : DEFAULT_AUTH_401_BURST_WINDOW_SEC * 1000;
  return { threshold, windowMs };
}

export type Auth401Counts = Record<Auth401Reason, number>;

function emptyCounts(): Auth401Counts {
  return {
    no_credentials: 0,
    session_resolution_error: 0,
    session_invalid: 0,
    agent_token_expired: 0,
    agent_token_invalid: 0,
    agent_token_agent_mismatch: 0,
    agent_token_agent_terminated: 0,
    agent_token_agent_pending: 0,
    agent_key_agent_mismatch: 0,
    agent_key_agent_terminated: 0,
    agent_key_agent_pending: 0,
    unknown: 0,
  };
}

export interface Auth401BurstSample {
  counts: Auth401Counts;
  /** 401s inside the current window (sum over buckets). */
  windowTotal: number;
  threshold: number;
  windowMs: number;
  tripped: boolean;
  /** ISO timestamp of the first 401 that tripped the latch (null when untripped). */
  trippedAt: string | null;
}

export interface Auth401BurstMetrics {
  /** Record one 401. `reason` must be a closed-set value or it collapses to "unknown". */
  record(reason: unknown, atMs?: number): void;
  read(nowMs?: number): Auth401BurstSample;
  reset(): void;
}

/** Where a detector gets its threshold/window. */
export type Auth401BurstSettingsSource = Auth401BurstSettings | (() => Auth401BurstSettings);

/**
 * The detector. Buckets are fixed-width slices of `windowMs`; a record lands in
 * `floor(atMs / bucketMs)`. On read, buckets older than one window are dropped,
 * so the window is sliding and the memory is bounded by the bucket count. The
 * latch (`tripped`) stays set until `reset()` so the board signal survives the
 * storm itself dying down — the operator dismisses the card, the latch is what
 * the card reads.
 */
export function createAuth401BurstMetrics(
  settingsSource: Auth401BurstSettingsSource = readAuth401BurstSettings,
): Auth401BurstMetrics {
  // Resolve lazily so a `() => settings` source picks up env changes (the
  // production singleton) while a plain object stays fixed (tests). The same
  // resolved value is used within one operation, so threshold and window can
  // never disagree mid-check.
  const resolve = (): Auth401BurstSettings =>
    typeof settingsSource === "function" ? settingsSource() : settingsSource;

  let counts = emptyCounts();
  let buckets = new Map<number, number>();
  let tripped = false;
  let trippedAtMs: number | null = null;
  let bucketMs = Math.max(1, Math.floor(resolve().windowMs / 60));

  function prune(nowMs: number, windowMs: number): void {
    const cutoff = nowMs - windowMs;
    const next = new Map<number, number>();
    for (const [bucketStart, bucketCount] of buckets) {
      if (bucketStart + bucketMs > cutoff) next.set(bucketStart, bucketCount);
    }
    buckets = next;
  }

  function windowTotal(): number {
    let total = 0;
    for (const bucketCount of buckets.values()) total += bucketCount;
    return total;
  }

  return {
    record(reason, atMs = Date.now()): void {
      const settings = resolve();
      // Re-derive the bucket width if the window changed (env override).
      bucketMs = Math.max(1, Math.floor(settings.windowMs / 60));
      const key: Auth401Reason = validReason(reason) ? reason : "unknown";
      counts[key] += 1;
      const bucketStart = Math.floor(atMs / bucketMs) * bucketMs;
      buckets.set(bucketStart, (buckets.get(bucketStart) ?? 0) + 1);
      if (!tripped && windowTotal() >= settings.threshold) {
        tripped = true;
        trippedAtMs = atMs;
      }
    },
    read(nowMs = Date.now()): Auth401BurstSample {
      const settings = resolve();
      bucketMs = Math.max(1, Math.floor(settings.windowMs / 60));
      prune(nowMs, settings.windowMs);
      return {
        counts: { ...counts },
        windowTotal: windowTotal(),
        threshold: settings.threshold,
        windowMs: settings.windowMs,
        tripped,
        trippedAt: trippedAtMs === null ? null : new Date(trippedAtMs).toISOString(),
      };
    },
    reset(): void {
      counts = emptyCounts();
      buckets = new Map();
      tripped = false;
      trippedAtMs = null;
    },
  };
}

/**
 * The process-global detector. Resolves threshold/window from env on every
 * operation so an operator override takes effect without a restart, and so the
 * error handler, the Prometheus scrape, and the board signal always read the
 * same live values.
 */
export const auth401BurstMetrics = createAuth401BurstMetrics(readAuth401BurstSettings);
