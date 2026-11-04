import { logger } from "../middleware/logger.js";

export type GitHubRequestSource = "ci-resolver" | "review-recovery" | "task-pr-sync" | "broker";

export interface GitHubRateLimitMetrics {
  remaining: number | null;
  limit: number | null;
  resetEpochSeconds: number | null;
  resetTimeUtc: string | null;
  isRateLimited: boolean;
  sources: Record<GitHubRequestSource, number>;
}

export function formatUtcTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

interface RateLimitState {
  remaining: number | null;
  limit: number | null;
  resetEpochSeconds: number | null;
  sources: Record<GitHubRequestSource, number>;
}

const state: RateLimitState = {
  remaining: null,
  limit: null,
  resetEpochSeconds: null,
  sources: {
    "ci-resolver": 0,
    "review-recovery": 0,
    "task-pr-sync": 0,
    broker: 0,
  },
};

export function recordGitHubRequest(
  source: GitHubRequestSource,
  response?: { status?: number; headers?: Headers | Record<string, string | null | undefined> } | null,
): void {
  state.sources[source] = (state.sources[source] ?? 0) + 1;

  if (!response) {
    return;
  }

  const getHeader = (name: string): string | null => {
    if (!response.headers) return null;
    if (typeof (response.headers as Headers).get === "function") {
      return (response.headers as Headers).get(name);
    }
    const record = response.headers as Record<string, string | null | undefined>;
    return record[name] ?? record[name.toLowerCase()] ?? null;
  };

  const remHeader = getHeader("x-ratelimit-remaining");
  if (remHeader !== null) {
    const parsed = parseInt(remHeader, 10);
    if (Number.isFinite(parsed)) {
      state.remaining = parsed;
    }
  }

  const limitHeader = getHeader("x-ratelimit-limit");
  if (limitHeader !== null) {
    const parsed = parseInt(limitHeader, 10);
    if (Number.isFinite(parsed)) {
      state.limit = parsed;
    }
  }

  const resetHeader = getHeader("x-ratelimit-reset");
  if (resetHeader !== null) {
    const parsed = parseInt(resetHeader, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      state.resetEpochSeconds = parsed;
    }
  }

  const status = response.status;
  const isExplicitRateLimit =
    status === 429 ||
    (status === 403 && (state.remaining === 0 || remHeader === "0"));

  if (isExplicitRateLimit) {
    if (!state.resetEpochSeconds || state.resetEpochSeconds * 1000 <= Date.now()) {
      state.resetEpochSeconds = Math.floor(Date.now() / 1000) + 3600;
    }
  }
}

export function isGitHubRateLimited(): boolean {
  if (state.resetEpochSeconds === null) {
    return false;
  }
  if (state.resetEpochSeconds * 1000 <= Date.now()) {
    // Reset time has passed
    state.resetEpochSeconds = null;
    return false;
  }
  return true;
}

export function getGitHubRateLimitResetEpochSeconds(): number | null {
  return isGitHubRateLimited() ? state.resetEpochSeconds : null;
}

export function getGitHubRateLimitResetTime(): string | null {
  const resetSec = getGitHubRateLimitResetEpochSeconds();
  if (!resetSec) return null;
  return formatUtcTime(new Date(resetSec * 1000));
}

export function getGitHubRateLimitMetrics(): GitHubRateLimitMetrics {
  const rateLimited = isGitHubRateLimited();
  return {
    remaining: state.remaining,
    limit: state.limit,
    resetEpochSeconds: rateLimited ? state.resetEpochSeconds : null,
    resetTimeUtc: rateLimited && state.resetEpochSeconds ? formatUtcTime(new Date(state.resetEpochSeconds * 1000)) : null,
    isRateLimited: rateLimited,
    sources: { ...state.sources },
  };
}

export function resetGitHubRateLimitForTests(): void {
  state.remaining = null;
  state.limit = null;
  state.resetEpochSeconds = null;
  state.sources = {
    "ci-resolver": 0,
    "review-recovery": 0,
    "task-pr-sync": 0,
    broker: 0,
  };
}

export function setGitHubRateLimitForTests(resetEpochSeconds: number, remaining = 0): void {
  state.resetEpochSeconds = resetEpochSeconds;
  state.remaining = remaining;
}

// 5-minute periodic logger
let logTimer: NodeJS.Timeout | null = null;
export function startGitHubRateLimitPeriodicLogging(intervalMs = 300_000): void {
  if (logTimer) return;
  logTimer = setInterval(() => {
    const metrics = getGitHubRateLimitMetrics();
    logger.info(
      {
        githubRateLimit: metrics,
      },
      `[github-rate-limit] remaining=${metrics.remaining ?? "unknown"}, sources=${JSON.stringify(metrics.sources)}, rateLimited=${metrics.isRateLimited}`,
    );
  }, intervalMs);
  logTimer.unref?.();
}

export function stopGitHubRateLimitPeriodicLogging(): void {
  if (logTimer) {
    clearInterval(logTimer);
    logTimer = null;
  }
}

// Start logging on initial load
startGitHubRateLimitPeriodicLogging();
