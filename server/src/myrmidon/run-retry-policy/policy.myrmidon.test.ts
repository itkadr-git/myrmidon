import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUN_RETRY_POLICY,
  MIN_RUN_RETRY_DELAY_MS,
  computeRunRetryBackoff,
  describeRunRetrySchedule,
  planRunRetry,
  readRunRetryPolicySettings,
  resolveRunRetryMaxAttempts,
  type RunRetryPolicySettings,
} from "./index.js";
import {
  PERMANENT_RUN_FAILURE_ERROR_CODES,
  TRANSIENT_RUN_FAILURE_ERROR_CODES,
} from "./classification.js";

const NOW = new Date("2026-10-09T12:00:00.000Z");
const SECOND = 1000;
const MINUTE = 60 * SECOND;

function settings(
  overrides: Partial<RunRetryPolicySettings> = {},
): RunRetryPolicySettings {
  return { ...DEFAULT_RUN_RETRY_POLICY, ...overrides };
}

function plan(input: {
  errorCode?: string | null;
  errorFamily?: string | null;
  attempt?: number;
  settings?: RunRetryPolicySettings;
  random?: () => number;
}) {
  return planRunRetry({
    failure: { errorCode: input.errorCode, errorFamily: input.errorFamily },
    attempt: input.attempt ?? 1,
    now: NOW,
    settings: input.settings,
    random: input.random,
  });
}

describe("run retry policy: exponential backoff", () => {
  it("doubles every attempt from the 60 s base the recovery used", () => {
    const delays = [1, 2, 3].map(
      (attempt) =>
        computeRunRetryBackoff({ attempt, now: NOW, settings: settings() })
          .delayMs,
    );
    expect(delays).toEqual([1 * MINUTE, 2 * MINUTE, 4 * MINUTE]);
  });

  it("applies the ceiling before the jitter", () => {
    const backoff = computeRunRetryBackoff({
      attempt: 2,
      now: NOW,
      settings: settings({ multiplier: 60, maxDelayMs: 30 * MINUTE }),
    });
    expect(backoff.rawDelayMs).toBe(60 * MINUTE);
    expect(backoff.delayMs).toBe(30 * MINUTE);
    expect(backoff.capped).toBe(true);

    const jittered = computeRunRetryBackoff({
      attempt: 2,
      now: NOW,
      settings: settings({ multiplier: 60, maxDelayMs: 30 * MINUTE, jitterRatio: 0.1 }),
      random: () => 1,
    });
    expect(jittered.delayMs).toBe(33 * MINUTE);
    expect(jittered.capped).toBe(true);
  });

  it("spreads the delay symmetrically when the jitter is on", () => {
    const jittered = (random: number) =>
      computeRunRetryBackoff({
        attempt: 1,
        now: NOW,
        settings: settings({ jitterRatio: 0.5 }),
        random: () => random,
      }).delayMs;
    expect(jittered(0)).toBe(30 * SECOND);
    expect(jittered(0.5)).toBe(1 * MINUTE);
    expect(jittered(1)).toBe(90 * SECOND);
  });

  it("never schedules a retry into the same instant", () => {
    const backoff = computeRunRetryBackoff({
      attempt: 1,
      now: NOW,
      settings: settings({ baseDelayMs: 0, multiplier: 1 }),
      random: () => 0,
    });
    expect(backoff.delayMs).toBe(MIN_RUN_RETRY_DELAY_MS);
    expect(backoff.dueAt.getTime() - NOW.getTime()).toBe(MIN_RUN_RETRY_DELAY_MS);
  });

  it("counts attempts from one, whatever it is handed", () => {
    expect(
      computeRunRetryBackoff({ attempt: 0, now: NOW, settings: settings() }).delayMs,
    ).toBe(1 * MINUTE);
    expect(
      computeRunRetryBackoff({ attempt: -5, now: NOW, settings: settings() }).delayMs,
    ).toBe(1 * MINUTE);
    expect(
      computeRunRetryBackoff({ attempt: 2.7, now: NOW, settings: settings() }).attempt,
    ).toBe(2);
  });
});

describe("run retry policy: decision and attempt limit", () => {
  it("schedules a transient failure at the backoff of its attempt", () => {
    const first = plan({ errorCode: "codex_transient_upstream" });
    expect(first).toMatchObject({
      retry: true,
      reason: "transient_failure_scheduled",
      classification: "transient",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 1 * MINUTE,
    });
    if (!first.retry) throw new Error("expected a scheduled retry");
    expect(first.dueAt.toISOString()).toBe("2026-10-09T12:01:00.000Z");

    const third = plan({ errorCode: "timeout", attempt: 3 });
    expect(third).toMatchObject({ retry: true, delayMs: 4 * MINUTE });
  });

  it("refuses the attempt past the limit of the class", () => {
    const past = plan({ errorCode: "timeout", attempt: 4 });
    expect(past).toMatchObject({
      retry: false,
      reason: "attempt_limit_reached",
      classification: "transient",
      maxAttempts: 3,
    });
    expect(past).not.toHaveProperty("dueAt");
  });

  it("spends one attempt on an unclassified failure, then stops", () => {
    const first = plan({ errorCode: "mystery_failure" });
    expect(first).toMatchObject({
      retry: true,
      classification: "unknown",
      attempt: 1,
      maxAttempts: 1,
    });
    expect(plan({ errorCode: "mystery_failure", attempt: 2 })).toMatchObject({
      retry: false,
      reason: "attempt_limit_reached",
      maxAttempts: 1,
    });
  });

  it("never schedules a permanent failure, at any attempt", () => {
    for (const errorCode of PERMANENT_RUN_FAILURE_ERROR_CODES) {
      const decision = plan({ errorCode, attempt: 1 });
      expect(decision).toMatchObject({
        retry: false,
        reason: "permanent_failure",
        classification: "permanent",
        maxAttempts: 0,
      });
    }
    expect(
      plan({ errorCode: "adapter_failed", errorFamily: "permanent_config_error" }),
    ).toMatchObject({ retry: false, reason: "permanent_failure" });
  });

  it("schedules every transient code the taxonomy knows", () => {
    for (const errorCode of TRANSIENT_RUN_FAILURE_ERROR_CODES) {
      expect(plan({ errorCode })).toMatchObject({
        retry: true,
        classification: "transient",
        maxAttempts: 3,
      });
    }
  });

  it("stops entirely when the policy is switched off", () => {
    expect(plan({ errorCode: "timeout", settings: settings({ enabled: false }) }))
      .toMatchObject({ retry: false, reason: "policy_disabled" });
  });

  it("honours a zero ceiling as 'no automatic retry'", () => {
    expect(
      plan({ errorCode: "timeout", settings: settings({ maxAttempts: 0 }) }),
    ).toMatchObject({ retry: false, reason: "attempt_limit_zero", maxAttempts: 0 });
    expect(
      plan({ errorCode: "mystery", settings: settings({ unknownMaxAttempts: 0 }) }),
    ).toMatchObject({ retry: false, reason: "attempt_limit_zero" });
  });

  it("reads the ceiling per class", () => {
    expect(resolveRunRetryMaxAttempts("transient")).toBe(3);
    expect(resolveRunRetryMaxAttempts("unknown")).toBe(1);
    expect(resolveRunRetryMaxAttempts("permanent")).toBe(0);
    expect(
      resolveRunRetryMaxAttempts("transient", settings({ maxAttempts: 5 })),
    ).toBe(5);
  });

  it("allows no attempt of any class while the policy is disabled", () => {
    const disabled = settings({ enabled: false });
    expect(resolveRunRetryMaxAttempts("transient", disabled)).toBe(0);
    expect(resolveRunRetryMaxAttempts("unknown", disabled)).toBe(0);
    expect(resolveRunRetryMaxAttempts("permanent", disabled)).toBe(0);
  });
});

describe("run retry policy: the attempt counter the UI reads", () => {
  it("describes the scheduled attempt as a flat JSON snapshot", () => {
    const snapshot = describeRunRetrySchedule({
      failure: { errorCode: "timeout", errorFamily: "transient_upstream" },
      attempt: 2,
      maxAttempts: 3,
      delayMs: 2 * MINUTE,
      now: NOW,
    });
    expect(snapshot).toEqual({
      classification: "transient",
      classificationReason: "transient_error_family",
      errorCode: "timeout",
      errorFamily: "transient_upstream",
      attempt: 2,
      maxAttempts: 3,
      delayMs: 2 * MINUTE,
      scheduledAt: "2026-10-09T12:00:00.000Z",
    });
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it("falls back to the ceiling of the class when the caller has none", () => {
    expect(
      describeRunRetrySchedule({
        failure: { errorCode: "budget_exhausted" },
        attempt: 1,
        maxAttempts: 0,
        delayMs: 0,
        now: NOW,
      }),
    ).toMatchObject({ classification: "permanent", maxAttempts: 0 });
    expect(
      describeRunRetrySchedule({
        failure: {},
        attempt: 1,
        maxAttempts: 0,
        delayMs: 0,
        now: NOW,
      }),
    ).toMatchObject({ classification: "unknown", maxAttempts: 1 });
  });
});

describe("run retry policy: settings", () => {
  it("defaults to the numbers the retry paths used", () => {
    expect(readRunRetryPolicySettings({})).toEqual({
      enabled: true,
      maxAttempts: 3,
      unknownMaxAttempts: 1,
      baseDelayMs: 60 * SECOND,
      multiplier: 2,
      maxDelayMs: 30 * MINUTE,
      jitterRatio: 0,
    });
  });

  it("ships enabled: a typo does not extinguish the policy", () => {
    for (const raw of ["", "1", "yes", "nope"]) {
      expect(
        readRunRetryPolicySettings({ MYRMIDON_RUN_RETRY_ENABLED: raw }).enabled,
      ).toBe(true);
    }
    for (const raw of ["0", "false", "off", "no", " OFF "]) {
      expect(
        readRunRetryPolicySettings({ MYRMIDON_RUN_RETRY_ENABLED: raw }).enabled,
      ).toBe(false);
    }
  });

  it("reads the interval variables and clamps them", () => {
    const custom = readRunRetryPolicySettings({
      MYRMIDON_RUN_RETRY_MAX_ATTEMPTS: "5",
      MYRMIDON_RUN_RETRY_UNKNOWN_MAX_ATTEMPTS: "2",
      MYRMIDON_RUN_RETRY_BASE_DELAY_SEC: "30",
      MYRMIDON_RUN_RETRY_MULTIPLIER: "3",
      MYRMIDON_RUN_RETRY_MAX_DELAY_SEC: "600",
      MYRMIDON_RUN_RETRY_JITTER_PERCENT: "25",
    });
    expect(custom).toEqual({
      enabled: true,
      maxAttempts: 5,
      unknownMaxAttempts: 2,
      baseDelayMs: 30 * SECOND,
      multiplier: 3,
      maxDelayMs: 10 * MINUTE,
      jitterRatio: 0.25,
    });

    // Out of range, fractional and non-numeric values fall back to the default
    // rather than to a nonsense schedule.
    expect(
      readRunRetryPolicySettings({
        MYRMIDON_RUN_RETRY_MAX_ATTEMPTS: "11",
        MYRMIDON_RUN_RETRY_BASE_DELAY_SEC: "0",
        MYRMIDON_RUN_RETRY_MULTIPLIER: "1.5",
        MYRMIDON_RUN_RETRY_MAX_DELAY_SEC: "soon",
        MYRMIDON_RUN_RETRY_JITTER_PERCENT: "80",
      }),
    ).toMatchObject({
      maxAttempts: 3,
      baseDelayMs: 60 * SECOND,
      multiplier: 2,
      maxDelayMs: 30 * MINUTE,
      jitterRatio: 0,
    });
  });

  it("keeps the ceiling reachable by the configured growth", () => {
    const capped = readRunRetryPolicySettings({
      MYRMIDON_RUN_RETRY_BASE_DELAY_SEC: "600",
      MYRMIDON_RUN_RETRY_MULTIPLIER: "10",
      MYRMIDON_RUN_RETRY_MAX_DELAY_SEC: "60",
    });
    expect(
      computeRunRetryBackoff({ attempt: 3, now: NOW, settings: capped }),
    ).toMatchObject({ delayMs: 60 * SECOND, capped: true });
  });
});