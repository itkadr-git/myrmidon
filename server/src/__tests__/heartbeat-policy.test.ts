// Task-level retry policy tests (1.7 RETRY-TASK-POLICY).
//
// The contract under test lives in server/src/services/heartbeat-policy.ts:
// `planTaskRetrySeries` turns an ordered series of failures into an ordered
// series of decisions. Three properties the ticket calls out are pinned here:
//
//   * determinism — the same ordered series of error codes produces the same
//     ordered series of decisions, on two consecutive calls with no injected
//     random source (the default jitter source is seeded from the series
//     fingerprint, so it is reproducible) and with an identical pinned source;
//   * the ceiling — the backoff never exceeds the operator ceiling plus the
//     jitter, and the attempt counter stops the schedule at maxAttempts;
//   * the counter — only attempts that reached a dispatch move it, a
//     pre-dispatch failure never does, and a success resets it.

import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RUN_RETRY_POLICY,
  MIN_RUN_RETRY_DELAY_MS,
} from "../myrmidon/run-retry-policy/index.js";
import {
  TASK_RETRY_REASON,
  TASK_RETRY_WAKE_REASON,
  planTaskRetry,
  planTaskRetrySeries,
  taskRetrySeriesFingerprint,
  type TaskRetryAttemptFailure,
} from "../services/heartbeat-policy.js";

const NOW = new Date("2026-11-08T09:00:00.000Z");
const MINUTE = 60_000;
const HALF_HOUR = 30 * MINUTE;

function settings(
  overrides: Partial<typeof DEFAULT_RUN_RETRY_POLICY> = {},
): typeof DEFAULT_RUN_RETRY_POLICY {
  return { ...DEFAULT_RUN_RETRY_POLICY, ...overrides };
}

const failTransient = (
  errorCode = "timeout",
): TaskRetryAttemptFailure => ({ errorCode });

describe("task retry policy: determinism", () => {
  it("the same series of codes yields the same series of decisions, twice", () => {
    const series: TaskRetryAttemptFailure[] = [
      { errorCode: "timeout" },
      { errorCode: "stream_interrupted" },
      { errorCode: "timeout", beforeDispatch: true },
      { errorCode: "timeout" },
    ];
    const seededFirst = planTaskRetrySeries({
      issueId: "issue-1",
      runId: "run-1",
      series,
      now: NOW,
    });
    const seededSecond = planTaskRetrySeries({
      issueId: "issue-1",
      runId: "run-1",
      series,
      now: NOW,
    });
    expect(seededSecond).toEqual(seededFirst);
    // The input is the same series of codes and attempt boundaries; the
    // decision is stable and independent of run ID.
    expect(
      planTaskRetrySeries({
        issueId: "issue-1",
        runId: "different-run",
        series,
        now: NOW,
      }),
    ).toEqual(seededFirst);
    // …and no decision depends on Math.random: every scheduled wait is
    // reproducible from the series fingerprint alone.
    for (const decision of seededFirst) {
      if (decision.retry) {
        expect(decision.dueAt.getTime()).toBe(NOW.getTime() + decision.delayMs);
      }
    }
  });

  it("two runs of one task with one code produce identical solutions", () => {
    // The ticket's false-accept trap: run A and run B of the same task fail
    // with the same ordered code series — their decision series must match,
    // delays and fingerprints included.
    const runA = planTaskRetrySeries({
      issueId: "issue-1",
      runId: "run-A",
      series: [failTransient(), failTransient(), failTransient()],
      now: NOW,
    });
    const runB = planTaskRetrySeries({
      issueId: "issue-1",
      runId: "run-B",
      series: [failTransient(), failTransient(), failTransient()],
      now: NOW,
    });
    expect(runA).toEqual(runB);
  });

  it("a pinned random source reproduces the seeded-source schedule", () => {
    const series = [failTransient(), failTransient()];
    const seeded = planTaskRetrySeries({
      issueId: "issue-1",
      series,
      now: NOW,
      settings: settings({ jitterRatio: 0.1 }),
    });
    const fingerprint = taskRetrySeriesFingerprint(series);
    // Recompute the seed the implementation derives: the same series must
    // produce the same delays when the caller supplies the identical source.
    const pinned = planTaskRetrySeries({
      issueId: "issue-1",
      series,
      now: NOW,
      settings: settings({ jitterRatio: 0.1 }),
      random: (() => {
        // Same mulberry32 as the implementation, seeded the same way.
        let state = 0;
        for (let i = 0; i < fingerprint.length; i += 1) {
          state = (Math.imul(state, 31) + fingerprint.charCodeAt(i)) >>> 0;
        }
        return () => {
          state = (state + 0x6d2b79f5) >>> 0;
          let t = state;
          t = Math.imul(t ^ (t >>> 15), t | 1);
          t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
      })(),
    });
    expect(pinned).toEqual(seeded);
  });
});

describe("task retry policy: exponential backoff with a ceiling", () => {
  it("doubles from the base and applies the ceiling", () => {
    const decisions = planTaskRetrySeries({
      issueId: "issue-1",
      series: [failTransient(), failTransient(), failTransient()],
      now: NOW,
      settings: settings({ jitterRatio: 0 }),
    });
    expect(
      decisions.map((d) => (d.retry ? d.rawDelayMs : null)),
    ).toEqual([MINUTE, 2 * MINUTE, 4 * MINUTE]);
    expect(decisions.every((d) => d.retry)).toBe(true);
  });

  it("never waits longer than the ceiling plus the jitter", () => {
    const long = planTaskRetrySeries({
      issueId: "issue-1",
      series: [
        failTransient(),
        failTransient(),
        failTransient(),
        failTransient(),
        failTransient(),
      ],
      now: NOW,
      // Deliberately unreachable attempt counts: the point is the delay
      // ceiling, so maxAttempts is raised above the series length.
      // multiplier=60: attempt 1 waits the base (under the ceiling), every
      // attempt from the second one is raw-capped at HALF_HOUR.
      settings: settings({
        maxAttempts: 10,
        multiplier: 60,
        maxDelayMs: HALF_HOUR,
        jitterRatio: 0.1,
      }),
    });
    for (const decision of long) {
      if (!decision.retry) continue;
      // Whatever the raw exponential value, the scheduled wait never leaves
      // the ceiling band: at most ceiling × (1 + jitterRatio).
      expect(decision.delayMs).toBeLessThanOrEqual(HALF_HOUR * 1.1);
    }
    // The capped arithmetic is shared with the run policy (RETRY-UNIFIED):
    // attempt 1 (60 s) is under the 30-minute ceiling, attempts 2+ are raw-
    // capped at it — base × 60^(n−1) grows past the ceiling immediately.
    expect(
      long.map((d) => (d.retry ? d.rawDelayMs >= HALF_HOUR : null)),
    ).toEqual([false, true, true, true, true]);
  });

  it("a delay never falls below the floor the run policy enforces", () => {
    const decision = planTaskRetry({
      issueId: "issue-1",
      failure: failTransient(),
      series: [],
      now: NOW,
      settings: settings({ baseDelayMs: 0 }),
    });
    expect(decision.retry).toBe(true);
    if (!decision.retry) return;
    expect(decision.delayMs).toBeGreaterThanOrEqual(MIN_RUN_RETRY_DELAY_MS);
  });
});

describe("task retry policy: the attempt counter", () => {
  it("stops scheduling after maxAttempts real attempts", () => {
    const decisions = planTaskRetrySeries({
      issueId: "issue-1",
      series: [failTransient(), failTransient(), failTransient(), failTransient()],
      now: NOW,
      settings: settings({ maxAttempts: 3, jitterRatio: 0 }),
    });
    expect(decisions.map((d) => d.retry)).toEqual([true, true, true, false]);
    expect(decisions[3]).toMatchObject({
      retry: false,
      reason: "attempt_limit_reached",
      attempt: 4,
      attemptCount: 4,
      maxAttempts: 3,
    });
  });

  it("a pre-dispatch failure never moves the counter", () => {
    const decisions = planTaskRetrySeries({
      issueId: "issue-1",
      series: [
        { errorCode: "timeout", beforeDispatch: true },
        { errorCode: "timeout", beforeDispatch: true },
        failTransient(),
      ],
      now: NOW,
      // The pre-dispatch budget (maxAttempts) allows exactly these two
      // pre-dispatch retries to be scheduled; only the third consecutive
      // pre-dispatch failure would be refused.
      settings: settings({ maxAttempts: 2, jitterRatio: 0 }),
    });
    // The two pre-dispatch failures schedule their retries (bounded budget),
    // but the counter stays at zero; the real attempt is the first one.
    expect(decisions[0]).toMatchObject({
      retry: true,
      attemptCount: 0,
      attempt: 1,
    });
    expect(decisions[1]).toMatchObject({
      retry: true,
      attemptCount: 0,
    });
    expect(decisions[2]).toMatchObject({
      retry: true,
      attempt: 1,
      attemptCount: 1,
    });
  });

  it("a success resets the counter for the next failure", () => {
    const decisions = planTaskRetrySeries({
      issueId: "issue-1",
      series: [
        failTransient(),
        failTransient(),
        { errorCode: "timeout", succeeded: true },
        failTransient(),
        failTransient(),
        failTransient(),
      ],
      now: NOW,
      settings: settings({ maxAttempts: 3, jitterRatio: 0 }),
    });
    expect(decisions.map((d) => d.retry)).toEqual([
      true,
      true,
      false,
      true,
      true,
      true,
    ]);
    // The third decision is the success: counter back to zero, no schedule.
    expect(decisions[2]).toMatchObject({
      retry: false,
      reason: "success",
      attemptCount: 0,
    });
    // After the reset the next failure spends a fresh budget.
    expect(decisions[3]).toMatchObject({
      retry: true,
      attempt: 1,
      attemptCount: 1,
    });
    // The second run's budget: the counter rose to 3 by the sixth failure.
    expect(decisions[5]).toMatchObject({
      retry: true,
      attempt: 3,
      attemptCount: 3,
    });
  });

  it("pre-dispatch failures are budgeted and cannot spin for ever", () => {
    const decisions = planTaskRetrySeries({
      issueId: "issue-1",
      series: [
        { errorCode: "adapter_failed", beforeDispatch: true },
        { errorCode: "adapter_failed", beforeDispatch: true },
        { errorCode: "adapter_failed", beforeDispatch: true },
        { errorCode: "adapter_failed", beforeDispatch: true },
      ],
      now: NOW,
      settings: settings({ maxAttempts: 3, jitterRatio: 0 }),
    });
    expect(decisions.map((d) => d.retry)).toEqual([true, true, true, false]);
    expect(decisions[3]).toMatchObject({
      retry: false,
      reason: "pre_dispatch_limit_reached",
    });
  });
});

describe("task retry policy: one wake reason and the classification", () => {
  it("every scheduled decision carries the single wake reason", () => {
    const decisions = planTaskRetrySeries({
      issueId: "issue-1",
      series: [failTransient(), failTransient()],
      now: NOW,
    });
    for (const decision of decisions) {
      if (decision.retry) {
        expect(decision.wakeReason).toBe(TASK_RETRY_WAKE_REASON);
        expect(decision.retryReason).toBe(TASK_RETRY_REASON);
      } else {
        expect(decision.wakeReason).toBeNull();
        expect(decision.retryReason).toBeNull();
      }
    }
  });

  it("a permanent failure is never scheduled whatever the counter says", () => {
    const decision = planTaskRetry({
      issueId: "issue-1",
      failure: { errorCode: "budget_exhausted" },
      series: [failTransient()],
      now: NOW,
      settings: settings({ maxAttempts: 3 }),
    });
    expect(decision).toMatchObject({
      retry: false,
      reason: "permanent_failure",
      classification: "permanent",
    });
  });

  it("an unknown code spends only the unknown budget", () => {
    const decisions = planTaskRetrySeries({
      issueId: "issue-1",
      series: [
        { errorCode: "some_unheard_of_code" },
        { errorCode: "some_unheard_of_code" },
      ],
      now: NOW,
      settings: settings({ maxAttempts: 3, unknownMaxAttempts: 1 }),
    });
    expect(decisions.map((d) => d.retry)).toEqual([true, false]);
    expect(decisions[0]).toMatchObject({ classification: "unknown" });
    expect(decisions[1]).toMatchObject({
      retry: false,
      reason: "attempt_limit_reached",
      maxAttempts: 1,
    });
  });

  it("a disabled policy schedules nothing", () => {
    const decision = planTaskRetry({
      issueId: "issue-1",
      failure: failTransient(),
      series: [],
      now: NOW,
      settings: settings({ enabled: false }),
    });
    expect(decision).toMatchObject({
      retry: false,
      reason: "policy_disabled",
      wakeReason: null,
    });
  });
});
