import { describe, expect, it } from "vitest";
import {
  SWARM_QUOTA_DEFAULT_HOLD_MS,
  SWARM_QUOTA_MAX_HOLD_MS,
  isAgentPaused,
  openLoadOf,
  quotaHoldUntil,
  type SwarmQuotaFailureFact,
} from "./eligibility.js";

const NOW = new Date("2026-10-20T12:00:00.000Z");
const MIN = 60_000;

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
