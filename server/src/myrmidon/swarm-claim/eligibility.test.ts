import { describe, expect, it } from "vitest";
import {
  SWARM_QUOTA_DEFAULT_HOLD_MS,
  SWARM_QUOTA_MAX_HOLD_MS,
  isAgentPaused,
  isIssueReady,
  openLoadOf,
  quotaHoldUntil,
  type SwarmQuotaFailureFact,
} from "./eligibility.js";

const NOW = new Date("2026-10-20T12:00:00.000Z");
const MIN = 60_000;

describe("isIssueReady", () => {
  const readyFacts = { hasOpenBlocker: false, onHold: false, hasProjectOrCaste: true, assignmentCompatible: true };
  const cases = [
    ["ready", readyFacts, true, null],
    ["open blocker", { ...readyFacts, hasOpenBlocker: true }, false, "open_blocker"],
    ["hold", { ...readyFacts, onHold: true }, false, "on_hold"],
    ["missing project and caste", { ...readyFacts, hasProjectOrCaste: false }, false, "missing_project_or_caste"],
    ["incompatible assignment", { ...readyFacts, assignmentCompatible: false }, false, "incompatible_assignment"],
    ["blocker takes precedence", { ...readyFacts, hasOpenBlocker: true, onHold: true }, false, "open_blocker"],
    ["hold takes precedence", { ...readyFacts, onHold: true, hasProjectOrCaste: false }, false, "on_hold"],
    ["no project despite compatible assignment", { ...readyFacts, hasProjectOrCaste: false }, false, "missing_project_or_caste"],
    ["assignment mismatch despite project", { ...readyFacts, assignmentCompatible: false }, false, "incompatible_assignment"],
    ["blocker among all failures", { hasOpenBlocker: true, onHold: true, hasProjectOrCaste: false, assignmentCompatible: false }, false, "open_blocker"],
    ["all later failures", { hasOpenBlocker: false, onHold: false, hasProjectOrCaste: true, assignmentCompatible: false }, false, "incompatible_assignment"],
  ] as const;
  it.each(cases)("%s", (_name, facts, ready, reason) => {
    expect(isIssueReady(facts)).toEqual({ ready, reason });
  });
});

function quota(overrides: Partial<SwarmQuotaFailureFact> = {}): SwarmQuotaFailureFact {
  return {
    errorCode: "provider_quota",
    error: "Individual quota reached",
    resultJson: null,
    occurredAt: new Date(NOW.getTime() - 10 * MIN),
    ...overrides,
  };
}

describe("openLoadOf", () => {
  it("counts a task once when it is both assigned and leased", () => {
    expect(openLoadOf(["a", "b"], ["b", "c"])).toBe(3);
    expect(openLoadOf([], [])).toBe(0);
  });

  it("releases only an assigned CI-waiting task while retaining live leases", () => {
    expect(openLoadOf(["ci", "active"], ["ci"], new Set(["ci"]))).toBe(2);
  });
});

describe("isAgentPaused", () => {
  it("is paused by status or by paused_at, and a heartbeat never lifts it", () => {
    expect(isAgentPaused({ status: "paused", pausedAt: null })).toBe(true);
    expect(isAgentPaused({ status: "idle", pausedAt: NOW })).toBe(true);
    expect(isAgentPaused({ status: "idle", pausedAt: null })).toBe(false);
    expect(isAgentPaused({ status: "running", pausedAt: undefined })).toBe(false);
  });
});

describe("quotaHoldUntil", () => {
  it("holds until the reset the failure recorded", () => {
    const reset = new Date(NOW.getTime() + 90 * MIN);
    const until = quotaHoldUntil({
      failures: [quota({ resultJson: { providerQuotaRetryNotBefore: reset.toISOString() } })],
      lastSuccessAt: null,
      now: NOW,
    });
    expect(until?.toISOString()).toBe(reset.toISOString());
  });

  it("holds for the default backoff when no reset was recorded, and expires with it", () => {
    const failure = quota({ occurredAt: new Date(NOW.getTime() - 10 * MIN) });
    const until = quotaHoldUntil({ failures: [failure], lastSuccessAt: null, now: NOW });
    expect(until?.getTime()).toBe(failure.occurredAt.getTime() + SWARM_QUOTA_DEFAULT_HOLD_MS);
    const after = new Date(until!.getTime() + 1);
    expect(quotaHoldUntil({ failures: [failure], lastSuccessAt: null, now: after })).toBeNull();
  });

  it("is released when the recorded reset has passed", () => {
    const reset = new Date(NOW.getTime() - MIN);
    expect(
      quotaHoldUntil({
        failures: [quota({ resultJson: { providerQuotaRetryNotBefore: reset.toISOString() } })],
        lastSuccessAt: null,
        now: NOW,
      }),
    ).toBeNull();
  });

  it("a transient failure of another kind never holds an agent", () => {
    expect(
      quotaHoldUntil({
        failures: [quota({ errorCode: "adapter_failed", error: "connection reset by peer" })],
        lastSuccessAt: null,
        now: NOW,
      }),
    ).toBeNull();
  });

  it("recognises the individual-quota text without an error code", () => {
    const until = quotaHoldUntil({
      failures: [quota({ errorCode: "adapter_failed", error: "Error: Individual quota reached for this key" })],
      lastSuccessAt: null,
      now: NOW,
    });
    expect(until).not.toBeNull();
  });

  it("a later success lifts the hold; an earlier success does not", () => {
    const failure = quota();
    expect(
      quotaHoldUntil({ failures: [failure], lastSuccessAt: new Date(NOW.getTime() - MIN), now: NOW }),
    ).toBeNull();
    expect(
      quotaHoldUntil({ failures: [failure], lastSuccessAt: new Date(NOW.getTime() - 30 * MIN), now: NOW }),
    ).not.toBeNull();
  });

  it("does not believe a reset further than the ceiling", () => {
    const failure = quota({
      resultJson: { providerQuotaRetryNotBefore: new Date(NOW.getTime() + 365 * 24 * 60 * MIN).toISOString() },
    });
    const until = quotaHoldUntil({ failures: [failure], lastSuccessAt: null, now: NOW });
    expect(until?.getTime()).toBe(failure.occurredAt.getTime() + SWARM_QUOTA_MAX_HOLD_MS);
  });

  it("takes the latest hold across several failures", () => {
    const early = quota({ occurredAt: new Date(NOW.getTime() - 50 * MIN) });
    const late = quota({ occurredAt: new Date(NOW.getTime() - 5 * MIN) });
    const until = quotaHoldUntil({ failures: [early, late], lastSuccessAt: null, now: NOW });
    expect(until?.getTime()).toBe(late.occurredAt.getTime() + SWARM_QUOTA_DEFAULT_HOLD_MS);
  });
});
