import { logger } from "../middleware/logger.js";

// myrmidon(OPE-11767): "board-merge" counts the requests of the board-side merge.
export type GitHubRequestSource = "ci-resolver" | "review-recovery" | "task-pr-sync" | "broker" | "board-merge";

export interface GitHubRateLimitMetrics {
  remaining: number | null;
  limit: number | null;
  resetEpochSeconds: number | null;
  resetTimeUtc: string | null;
  windowResetEpochSeconds: number | null;
  windowResetUtc: string | null;
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
  windowResetEpochSeconds: number | null;
  rateLimitResetEpochSeconds: number | null;
  sources: Record<GitHubRequestSource, number>;
}

const state: RateLimitState = {
  remaining: null,
  limit: null,
  windowResetEpochSeconds: null,
  rateLimitResetEpochSeconds: null,
  sources: {
    "ci-resolver": 0,
    "review-recovery": 0,
    "task-pr-sync": 0,
    broker: 0,
    "board-merge": 0,
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
  let parsedRemaining: number | null = null;
  if (remHeader !== null) {
    const parsed = parseInt(remHeader, 10);
    if (Number.isFinite(parsed)) {
      parsedRemaining = parsed;
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
      state.windowResetEpochSeconds = parsed;
    }
  }

  const retryAfterHeader = getHeader("retry-after");
  let retryAfterEpochSeconds: number | null = null;
  if (retryAfterHeader !== null) {
    const parsed = parseInt(retryAfterHeader, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      retryAfterEpochSeconds = Math.floor(Date.now() / 1000) + parsed;
    } else {
      const parsedDate = Date.parse(retryAfterHeader);
      if (!Number.isNaN(parsedDate)) {
        const sec = Math.floor(parsedDate / 1000);
        if (sec > Math.floor(Date.now() / 1000)) {
          retryAfterEpochSeconds = sec;
        }
      }
    }
  }

  const status = response.status;
  const isSecondaryRateLimit = (status === 403 || status === 429) && retryAfterEpochSeconds !== null;
  const isPrimaryRateLimit =
    status === 429 ||
    (status === 403 && (state.remaining === 0 || remHeader === "0")) ||
    (parsedRemaining === 0);

  if (isSecondaryRateLimit || isPrimaryRateLimit) {
    if (retryAfterEpochSeconds !== null) {
      state.rateLimitResetEpochSeconds = retryAfterEpochSeconds;
    } else if (state.windowResetEpochSeconds && state.windowResetEpochSeconds * 1000 > Date.now()) {
      state.rateLimitResetEpochSeconds = state.windowResetEpochSeconds;
    } else {
      state.rateLimitResetEpochSeconds = Math.floor(Date.now() / 1000) + 3600;
    }
  } else if (status !== undefined && status >= 200 && status < 400 && state.remaining !== null && state.remaining > 0) {
    state.rateLimitResetEpochSeconds = null;
  }
}

export function isGitHubRateLimited(): boolean {
  const now = Date.now();

  if (state.rateLimitResetEpochSeconds !== null) {
    if (state.rateLimitResetEpochSeconds * 1000 <= now) {
      state.rateLimitResetEpochSeconds = null;
      if (state.remaining === 0) {
        state.remaining = null;
      }
      return false;
    }
    return true;
  }

  if (state.remaining === 0) {
    if (state.windowResetEpochSeconds !== null) {
      if (state.windowResetEpochSeconds * 1000 <= now) {
        state.remaining = null;
        return false;
      }
      return true;
    }
    return true;
  }

  return false;
}

export function getGitHubRateLimitResetEpochSeconds(): number | null {
  if (!isGitHubRateLimited()) {
    return null;
  }
  return state.rateLimitResetEpochSeconds ?? state.windowResetEpochSeconds;
}

export function getGitHubRateLimitResetTime(): string | null {
  const resetSec = getGitHubRateLimitResetEpochSeconds();
  if (!resetSec) return null;
  return formatUtcTime(new Date(resetSec * 1000));
}

export function getGitHubRateLimitMetrics(): GitHubRateLimitMetrics {
  const rateLimited = isGitHubRateLimited();
  const resetEpochSeconds = getGitHubRateLimitResetEpochSeconds();
  const resetTimeUtc = resetEpochSeconds ? formatUtcTime(new Date(resetEpochSeconds * 1000)) : null;
  const windowResetUtc = state.windowResetEpochSeconds ? formatUtcTime(new Date(state.windowResetEpochSeconds * 1000)) : null;

  return {
    remaining: state.remaining,
    limit: state.limit,
    resetEpochSeconds,
    resetTimeUtc,
    windowResetEpochSeconds: state.windowResetEpochSeconds,
    windowResetUtc,
    isRateLimited: rateLimited,
    sources: { ...state.sources },
  };
}

export function resetGitHubRateLimitForTests(): void {
  state.remaining = null;
  state.limit = null;
  state.windowResetEpochSeconds = null;
  state.rateLimitResetEpochSeconds = null;
  state.sources = {
    "ci-resolver": 0,
    "review-recovery": 0,
    "task-pr-sync": 0,
    broker: 0,
    "board-merge": 0,
  };
}

export function setGitHubRateLimitForTests(resetEpochSeconds: number, remaining = 0): void {
  state.windowResetEpochSeconds = resetEpochSeconds;
  state.rateLimitResetEpochSeconds = resetEpochSeconds;
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
      `[github-rate-limit] remaining=${metrics.remaining ?? "unknown"}, sources=${JSON.stringify(metrics.sources)}, rateLimited=${metrics.isRateLimited}, windowReset=${metrics.windowResetUtc ?? "unknown"}`,
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
