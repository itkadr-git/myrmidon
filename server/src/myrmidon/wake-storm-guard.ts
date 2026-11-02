/**
 * Per-agent wake storm circuit breaker (1.6.7 WAKE-STORM-GUARD).
 *
 * The admission path calls this before creating a run. A source is identified
 * by its explicit source key (rule/watchdog/trigger); repeated events from the
 * same source are counted in a sliding window. The first K wakes pass, the
 * next wake trips the source for the remainder of the window, and a trip is
 * reported exactly once per window.
 */

export const WAKE_STORM_LIMIT_ENV = "MYRMIDON_WAKE_STORM_LIMIT";
export const WAKE_STORM_WINDOW_ENV = "MYRMIDON_WAKE_STORM_WINDOW_MS";
export const DEFAULT_WAKE_STORM_LIMIT = 20;
export const DEFAULT_WAKE_STORM_WINDOW_MS = 10_000;

export type WakeStormSettings = {
  limit: number;
  windowMs: number;
};

export type WakeStormAdmission = {
  allowed: boolean;
  sourceKey: string;
  count: number;
  tripped: boolean;
};

type Bucket = {
  timestamps: number[];
  pausedUntil: number;
  alertedAt: number | null;
};

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function readWakeStormSettings(env: NodeJS.ProcessEnv = process.env): WakeStormSettings {
  return {
    limit: positiveInteger(env[WAKE_STORM_LIMIT_ENV], DEFAULT_WAKE_STORM_LIMIT),
    windowMs: positiveNumber(env[WAKE_STORM_WINDOW_ENV], DEFAULT_WAKE_STORM_WINDOW_MS),
  };
}

export class WakeStormGuard {
  private readonly buckets = new Map<string, Bucket>();

  public readonly settings: WakeStormSettings;

  constructor(settings: WakeStormSettings = readWakeStormSettings()) {
    this.settings = settings;
  }

  admit(agentId: string, sourceKey: string, now = Date.now()): WakeStormAdmission {
    const normalizedSource = sourceKey.trim() || "unknown";
    const key = `${agentId}:${normalizedSource}`;
    const bucket = this.buckets.get(key) ?? { timestamps: [], pausedUntil: 0, alertedAt: null };
    const cutoff = now - this.settings.windowMs;
    bucket.timestamps = bucket.timestamps.filter((timestamp) => timestamp > cutoff);

    if (bucket.pausedUntil > now) {
      this.buckets.set(key, bucket);
      return { allowed: false, sourceKey: normalizedSource, count: bucket.timestamps.length, tripped: false };
    }

    bucket.pausedUntil = 0;
    bucket.alertedAt = null;
    if (bucket.timestamps.length >= this.settings.limit) {
      bucket.pausedUntil = now + this.settings.windowMs;
      bucket.alertedAt = now;
      this.buckets.set(key, bucket);
      return { allowed: false, sourceKey: normalizedSource, count: bucket.timestamps.length, tripped: true };
    }

    bucket.timestamps.push(now);
    this.buckets.set(key, bucket);
    return { allowed: true, sourceKey: normalizedSource, count: bucket.timestamps.length, tripped: false };
  }

  clear(): void {
    this.buckets.clear();
  }
}

export function wakeStormSourceKey(input: {
  source?: string | null;
  reason?: string | null;
  payload?: Record<string, unknown> | null;
  contextSnapshot?: Record<string, unknown>;
}): string {
  const payload = input.payload ?? {};
  const context = input.contextSnapshot ?? {};
  for (const candidate of [
    payload.wakeSource,
    payload.sourceKey,
    payload.triggerId,
    payload.watchdogId,
    context.wakeSource,
    context.sourceKey,
    context.triggerId,
    context.watchdogId,
    input.reason,
    input.source,
  ]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "unknown";
}
