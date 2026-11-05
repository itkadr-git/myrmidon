import { describe, expect, it, beforeEach, vi, afterEach } from \"vitest\";
import {
  recordGitHubRequest,
  isGitHubRateLimited,
  getGitHubRateLimitResetEpochSeconds,
  getGitHubRateLimitResetTime,
  getGitHubRateLimitMetrics,
  resetGitHubRateLimitForTests,
  setGitHubRateLimitForTests,
  formatUtcTime,
} from \"../github-rate-limit.js\";

describe(\"github-rate-limit service\", () => {
  beforeEach(() => {
    resetGitHubRateLimitForTests();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it(\"response 200 with remaining=935 and reset in future does not rate limit\", () => {
    const futureResetEpoch = Math.floor(Date.now() / 1000) + 1800; // +30 mins
    recordGitHubRequest(\"ci-resolver\", {
      status: 200,
      headers: {
        \"x-ratelimit-remaining\": \"935\",
        \"x-ratelimit-limit\": \"5000\",\n        \"x-ratelimit-reset\": String(futureResetEpoch),
      },
    });

    expect(isGitHubRateLimited()).toBe(false);
    expect(getGitHubRateLimitResetEpochSeconds()).toBeNull();
    expect(getGitHubRateLimitResetTime()).toBeNull();

    const metrics = getGitHubRateLimitMetrics();
    expect(metrics.remaining).toBe(935);
    expect(metrics.limit).toBe(5000);
    expect(metrics.isRateLimited).toBe(false);
    expect(metrics.resetEpochSeconds).toBeNull();
    expect(metrics.resetTimeUtc).toBeNull();
    expect(metrics.windowResetEpochSeconds).toBe(futureResetEpoch);
    expect(metrics.windowResetUtc).toBe(formatUtcTime(new Date(futureResetEpoch * 1000)));
    expect(metrics.sources[\"ci-resolver\"]).toBe(1);
  });

  it(\"response 403 with remaining=0 sets rate limit until reset, and clears after reset\", () => {
    const now = 1730000000000;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));

    const resetEpoch = Math.floor(now / 1000) + 600; // +10 minutes
    recordGitHubRequest(\"ci-resolver\", {
      status: 403,
      headers: {
        \"x-ratelimit-remaining\": \"0\",
        \"x-ratelimit-limit\": \"5000\",
        \"x-ratelimit-reset\": String(resetEpoch),
      },
    });

    expect(isGitHubRateLimited()).toBe(true);
    expect(getGitHubRateLimitResetEpochSeconds()).toBe(resetEpoch);
    expect(getGitHubRateLimitResetTime()).toBe(formatUtcTime(new Date(resetEpoch * 1000)));

    const metricsBefore = getGitHubRateLimitMetrics();
    expect(metricsBefore.isRateLimited).toBe(true);
    expect(metricsBefore.remaining).toBe(0);
    expect(metricsBefore.resetEpochSeconds).toBe(resetEpoch);
    expect(metricsBefore.resetTimeUtc).toBe(formatUtcTime(new Date(resetEpoch * 1000)));
    expect(metricsBefore.windowResetUtc).toBe(formatUtcTime(new Date(resetEpoch * 1000)));

    // Fast-forward past reset time
    vi.advanceTimersByTime(601 * 1000);

    expect(isGitHubRateLimited()).toBe(false);
    expect(getGitHubRateLimitResetEpochSeconds()).toBeNull();
    expect(getGitHubRateLimitResetTime()).toBeNull();

    const metricsAfter = getGitHubRateLimitMetrics();
    expect(metricsAfter.isRateLimited).toBe(false);
    expect(metricsAfter.resetEpochSeconds).toBeNull();
    expect(metricsAfter.resetTimeUtc).toBeNull();
  });

  it(\"explicit rate limit without reset header defaults to +3600 seconds\", () => {
    const now = 1730000000000;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));

    recordGitHubRequest(\"broker\", {
      status: 429,
      headers: {},
    });

    expect(isGitHubRateLimited()).toBe(true);
    const expectedReset = Math.floor(now / 1000) + 3600;
    expect(getGitHubRateLimitResetEpochSeconds()).toBe(expectedReset);

    // Fast-forward 3599 seconds -> still rate limited
    vi.advanceTimersByTime(3599 * 1000);
    expect(isGitHubRateLimited()).toBe(true);

    // Fast-forward 2 more seconds -> rate limit cleared
    vi.advanceTimersByTime(2 * 1000);
    expect(isGitHubRateLimited()).toBe(false);
  });

  it(\"secondary rate limit with retry-after header uses retry-after seconds\", () => {
    const now = 1730000000000;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));

    recordGitHubRequest(\"review-recovery\", {
      status: 403,
      headers: {
        \"retry-after\": \"120\",
      },
    });

    expect(isGitHubRateLimited()).toBe(true);
    const expectedReset = Math.floor(now / 1000) + 120;
    expect(getGitHubRateLimitResetEpochSeconds()).toBe(expectedReset);

    vi.advanceTimersByTime(119 * 1000);
    expect(isGitHubRateLimited()).toBe(true);

    vi.advanceTimersByTime(2 * 1000);
    expect(isGitHubRateLimited()).toBe(false);
  });

  it(\"response 403 with non-zero remaining (e.g. permission error) does not rate limit\", () => {
    const futureResetEpoch = Math.floor(Date.now() / 1000) + 1800;
    recordGitHubRequest(\"task-pr-sync\", {
      status: 403,
      headers: {
        \"x-ratelimit-remaining\": \"4990\",
        \"x-ratelimit-limit\": \"5000\",
        \"x-ratelimit-reset\": String(futureResetEpoch),
      },
    });

    expect(isGitHubRateLimited()).toBe(false);
    expect(getGitHubRateLimitResetEpochSeconds()).toBeNull();
  });

  it(\"successful response with remaining quota clears an earlier rate limit\", () => {
    const futureResetEpoch = Math.floor(Date.now() / 1000) + 3600;
    setGitHubRateLimitForTests(futureResetEpoch, 0);
    expect(isGitHubRateLimited()).toBe(true);

    recordGitHubRequest(\"ci-resolver\", {
      status: 200,
      headers: {
        \"x-ratelimit-remaining\": \"500\",
        \"x-ratelimit-reset\": String(futureResetEpoch),
      },
    });

    expect(isGitHubRateLimited()).toBe(false);
    expect(getGitHubRateLimitResetEpochSeconds()).toBeNull();
    const metrics = getGitHubRateLimitMetrics();
    expect(metrics.isRateLimited).toBe(false);
    expect(metrics.remaining).toBe(500);
  });
});
