// server/src/myrmidon/bot-containers/dockergate-pacing.ts
//
// myrmidon(1.6.5-DOCKERGATE-A2A3-STORM): the board-side pacing of calls to
// dockergate. The gate keeps a global token bucket (tools/dockergate/internal/
// config/config.go: GlobalRate 50/s) and per-bot buckets; when the board's
// loops outpace them the gate answers 429 (rate_limited / concurrency_limited)
// and a fleet rollout stalls. Two mechanisms live here:
//
// - RateLimiter: an async token bucket in front of the client, so no matter how
//   many loops run (sweep, health wait, clone-report collection, "apply now")
//   the aggregate leaving the board stays under MYRMIDON_DOCKERGATE_MAX_RPS.
// - backoffDelayMs / parseRetryAfterMs: the retry pacing after a 429 —
//   exponential with jitter, and a server Retry-After header is respected when
//   the gate (or a proxy) sends one.
//
// Pure (clock, sleep and rng injected): the docker driver wires them together;
// tests assert the schedule without waiting on the wall clock.

/** Async token bucket. `acquire` resolves when a token is available. */
export interface RateLimiter {
  acquire(): Promise<void>;
  /** Number of callers queued behind the bucket (for tests/diagnostics). */
  waiting(): number;
}

/**
 * A bucket refilling at `ratePerSec` with a burst of one second's tokens.
 * ratePerSec <= 0 disables pacing: `acquire` resolves immediately.
 * `clock`/`sleep` are injected so tests drive the schedule.
 */
export function createRateLimiter(opts: {
  ratePerSec: number;
  clock: () => number;
  sleep: (ms: number) => Promise<void>;
}): RateLimiter {
  const { ratePerSec, clock, sleep } = opts;
  if (!(ratePerSec > 0)) {
    return { acquire: async () => undefined, waiting: () => 0 };
  }
  const burst = Math.max(1, ratePerSec);
  let tokens = burst;
  let last = clock();
  let waiting = 0;

  function refill(): void {
    const now = clock();
    if (now > last) {
      tokens = Math.min(burst, tokens + ((now - last) / 1000) * ratePerSec);
      last = now;
    }
  }

  async function acquire(): Promise<void> {
    for (;;) {
      refill();
      if (tokens >= 1) {
        tokens -= 1;
        return;
      }
      // Wake exactly when the missing token exists, plus a millisecond in case
      // the injected clock truncates.
      const waitMs = Math.max(1, Math.ceil(((1 - tokens) / ratePerSec) * 1000));
      waiting += 1;
      try {
        await sleep(waitMs);
      } finally {
        waiting -= 1;
      }
    }
  }

  return { acquire, waiting: () => waiting };
}

/** The 429 retry budget of one call: attempts beyond the first, and the
 *  exponential schedule behind them. */
export const RATE_LIMIT_MAX_RETRIES = 5;
export const RATE_LIMIT_BACKOFF_BASE_MS = 1_000;
export const RATE_LIMIT_BACKOFF_CAP_MS = 30_000;

/**
 * The delay before retry `attempt` (1-based) of a call the gate refused with
 * 429: exponential from `baseMs`, capped at `capMs`, with FULL jitter — the
 * wait is uniform in [0, min(capMs, baseMs * 2^(attempt-1))]. Full jitter (not
 * ±) is the shape that actually decorrelates the board's parallel loops: a
 * fixed delay would re-synchronise every retrying caller onto the same token
 * that just refilled, which is how the 05.10 rollout kept hitting 429 in waves.
 */
export function backoffDelayMs(
  attempt: number,
  opts: {
    rng: () => number;
    baseMs?: number;
    capMs?: number;
  },
): number {
  const baseMs = opts.baseMs ?? RATE_LIMIT_BACKOFF_BASE_MS;
  const capMs = opts.capMs ?? RATE_LIMIT_BACKOFF_CAP_MS;
  const window = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(window * opts.rng());
}

/**
 * The `Retry-After` header of a 429 as milliseconds, or null when absent or
 * unparsable. Both forms of RFC 9110 are accepted: the delay-seconds form
 * (`Retry-After: 5`) and the HTTP-date form. A negative or absurd (> 5 min)
 * value is treated as absent — a client must not hand the gate's clock a
 * licence to stall a rollout indefinitely.
 */
export function parseRetryAfterMs(header: string | undefined | null, nowMs: number): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed) return null;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    if (seconds < 0) return null;
    const ms = Math.round(seconds * 1000);
    return ms <= 300_000 ? ms : null;
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  const ms = at - nowMs;
  if (ms <= 0) return 0;
  return ms <= 300_000 ? ms : null;
}
