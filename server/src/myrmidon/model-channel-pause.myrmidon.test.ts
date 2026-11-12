import { describe, expect, it } from "vitest";
import {
  MODEL_CHANNEL_PAUSE_JITTER_MS,
  MODEL_CHANNEL_PAUSE_LADDER_MS,
  MODEL_CHANNEL_STREAK_MAX_GAP_MS,
  classifyModelChannelRun,
  computeModelChannelPause,
  computeModelChannelPauseDueAt,
  isModelChannelPausePollWake,
  isWakeSubjectToModelChannelPause,
  modelChannelPauseDelayMs,
  type ModelChannelRunFacts,
} from "./model-channel-pause.js";

const MINUTE = 60 * 1000;
const T0 = new Date("2026-11-11T10:12:20.000Z").getTime();

/** The run the board recorded on 11.11.2026: the gateway answered HTTP 500 before the model. */
function upstream500(finishedAtMs: number): ModelChannelRunFacts {
  return {
    status: "failed",
    errorCode: "hermes_gateway_upstream_error",
    errorFamily: "transient_upstream",
    modelResponseStarted: false,
    modelUnavailable: null,
    inputTokens: 0,
    outputTokens: 0,
    finishedAt: new Date(finishedAtMs),
  };
}

function succeeded(finishedAtMs: number): ModelChannelRunFacts {
  return {
    status: "succeeded",
    errorCode: null,
    errorFamily: null,
    modelResponseStarted: true,
    inputTokens: 1200,
    outputTokens: 80,
    finishedAt: new Date(finishedAtMs),
  };
}

describe("model channel pause (OPE-12800)", () => {
  it("grows 1, 2, 5, 15, 30 minutes and stays at 30", () => {
    expect(MODEL_CHANNEL_PAUSE_LADDER_MS.map((ms) => ms / MINUTE)).toEqual([1, 2, 5, 15, 30]);
    expect([1, 2, 3, 4, 5, 6, 50].map((streak) => modelChannelPauseDelayMs(streak) / MINUTE)).toEqual([
      1, 2, 5, 15, 30, 30, 30,
    ]);
    expect(modelChannelPauseDelayMs(0)).toBe(0);
  });

  it("treats the gateway HTTP 500 run as a channel failure whatever woke it", () => {
    expect(classifyModelChannelRun(upstream500(T0))).toBe("channel_failure");
  });

  it("counts quota and model-unavailable failures as channel failures", () => {
    expect(
      classifyModelChannelRun({
        status: "failed",
        errorCode: "hermes_gateway_run_failed",
        errorFamily: "provider_quota",
        finishedAt: new Date(T0),
      }),
    ).toBe("channel_failure");
    expect(
      classifyModelChannelRun({
        status: "failed",
        errorCode: "hermes_gateway_run_failed",
        modelUnavailable: true,
        finishedAt: new Date(T0),
      }),
    ).toBe("channel_failure");
  });

  it("does not count a failure in which the model answered", () => {
    expect(
      classifyModelChannelRun({
        status: "failed",
        errorCode: "hermes_gateway_run_failed",
        errorFamily: "transient_upstream",
        modelResponseStarted: true,
        finishedAt: new Date(T0),
      }),
    ).toBe("model_answered");
    expect(
      classifyModelChannelRun({
        status: "failed",
        errorCode: "hermes_gateway_run_failed",
        inputTokens: 52_000,
        finishedAt: new Date(T0),
      }),
    ).toBe("model_answered");
  });

  it("leaves the agent's own gateway failures and unrelated outcomes to their own handling", () => {
    for (const errorCode of [
      "hermes_gateway_connect_failed",
      "hermes_gateway_rate_limited",
      "hermes_gateway_predecessor_running",
    ]) {
      expect(
        classifyModelChannelRun({
          status: "failed",
          errorCode,
          errorFamily: "transient_upstream",
          finishedAt: new Date(T0),
        }),
      ).toBe("neutral");
    }
    expect(
      classifyModelChannelRun({ status: "cancelled", errorCode: "cancelled", finishedAt: new Date(T0) }),
    ).toBe("neutral");
    expect(
      classifyModelChannelRun({ status: "failed", errorCode: "workspace_busy", finishedAt: new Date(T0) }),
    ).toBe("neutral");
    expect(classifyModelChannelRun({ ...upstream500(T0), finishedAt: null })).toBe("neutral");
  });

  it("gives no pause to an agent without channel failures", () => {
    expect(computeModelChannelPause([], new Date(T0))).toBeNull();
    expect(computeModelChannelPause([succeeded(T0)], new Date(T0 + 1000))).toBeNull();
  });

  it("pauses the agent for a minute after the first failure and lets it run after that", () => {
    const runs = [succeeded(T0 - 10 * MINUTE), upstream500(T0)];
    const pause = computeModelChannelPause(runs, new Date(T0 + 30 * 1000));
    expect(pause).not.toBeNull();
    expect(pause!.streak).toBe(1);
    expect(pause!.pauseUntil.toISOString()).toBe(new Date(T0 + 1 * MINUTE).toISOString());
    expect(computeModelChannelPause(runs, new Date(T0 + 1 * MINUTE))).toBeNull();
  });

  // The reproduction of the incident: the same agent fails through an idle
  // pickup, its two 30 s retries, and the next idle pickup. Before the fix each
  // new wake started from zero; the streak now belongs to the agent.
  it("keeps one streak across wake reasons: the fourth failure in a row pauses for 15 minutes", () => {
    const runs = [
      upstream500(T0), // idle_pickup
      upstream500(T0 + 34 * 1000), // transient_failure_retry 1
      upstream500(T0 + 68 * 1000), // transient_failure_retry 2
      upstream500(T0 + 4 * MINUTE), // next idle_pickup
    ];
    const pause = computeModelChannelPause(runs, new Date(T0 + 4 * MINUTE + 47 * 1000));
    expect(pause!.streak).toBe(4);
    expect(pause!.delayMs).toBe(15 * MINUTE);
    expect(pause!.pauseUntil.getTime()).toBe(T0 + 19 * MINUTE);
  });

  it("never pauses longer than the ceiling, however long the outage", () => {
    const runs = Array.from({ length: 30 }, (_, i) => upstream500(T0 + i * 30 * MINUTE));
    const last = T0 + 29 * 30 * MINUTE;
    const pause = computeModelChannelPause(runs, new Date(last + 1000));
    expect(pause!.streak).toBe(30);
    expect(pause!.pauseUntil.getTime()).toBe(last + 30 * MINUTE);
    expect(computeModelChannelPause(runs, new Date(last + 30 * MINUTE))).toBeNull();
  });

  it("is reset by the first run in which the model answered", () => {
    const runs = [
      upstream500(T0),
      upstream500(T0 + 2 * MINUTE),
      upstream500(T0 + 5 * MINUTE),
      succeeded(T0 + 11 * MINUTE),
    ];
    expect(computeModelChannelPause(runs, new Date(T0 + 11 * MINUTE + 1000))).toBeNull();
    // The next outage starts from the first step again.
    const again = computeModelChannelPause(
      [...runs, upstream500(T0 + 20 * MINUTE)],
      new Date(T0 + 20 * MINUTE + 1000),
    );
    expect(again!.streak).toBe(1);
    expect(again!.delayMs).toBe(1 * MINUTE);
  });

  it("skips runs that say nothing about the channel without ending the streak", () => {
    const pause = computeModelChannelPause(
      [
        upstream500(T0),
        { status: "cancelled", errorCode: "cancelled", finishedAt: new Date(T0 + 30 * 1000) },
        upstream500(T0 + 2 * MINUTE),
      ],
      new Date(T0 + 2 * MINUTE + 1000),
    );
    expect(pause!.streak).toBe(2);
  });

  it("does not join failures of two separate outages into one streak", () => {
    const later = T0 + MODEL_CHANNEL_STREAK_MAX_GAP_MS + 5 * MINUTE;
    const pause = computeModelChannelPause(
      [upstream500(T0 - 2 * MINUTE), upstream500(T0 - MINUTE), upstream500(T0), upstream500(later)],
      new Date(later + 1000),
    );
    expect(pause!.streak).toBe(1);
  });

  it("does not depend on the order the runs are given in", () => {
    const runs = [upstream500(T0 + 68 * 1000), succeeded(T0 - MINUTE), upstream500(T0), upstream500(T0 + 34 * 1000)];
    expect(computeModelChannelPause(runs, new Date(T0 + 70 * 1000))!.streak).toBe(3);
  });

  it("holds every automatic wake and lets a user's wake through", () => {
    expect(isWakeSubjectToModelChannelPause({ requestedByActorType: "system" })).toBe(true);
    expect(isWakeSubjectToModelChannelPause({ requestedByActorType: "agent" })).toBe(true);
    expect(isWakeSubjectToModelChannelPause({})).toBe(true);
    expect(isWakeSubjectToModelChannelPause({ requestedByActorType: "user" })).toBe(false);
    expect(isWakeSubjectToModelChannelPause({ manualUserWake: true, requestedByActorType: "user" })).toBe(false);
  });

  it("drops polls and parks wakes that carry an event", () => {
    expect(isModelChannelPausePollWake("idle_pickup")).toBe(true);
    expect(isModelChannelPausePollWake("heartbeat_timer")).toBe(true);
    expect(isModelChannelPausePollWake("swarm_matched")).toBe(false);
    expect(isModelChannelPausePollWake("transient_failure_retry")).toBe(false);
    expect(isModelChannelPausePollWake("issue_assigned")).toBe(false);
    expect(isModelChannelPausePollWake(null)).toBe(false);
  });

  it("makes a parked run due at the end of the pause plus a bounded jitter", () => {
    const until = new Date(T0 + 5 * MINUTE);
    expect(computeModelChannelPauseDueAt(until, () => 0).getTime()).toBe(until.getTime());
    const latest = computeModelChannelPauseDueAt(until, () => 1).getTime() - until.getTime();
    expect(latest).toBe(MODEL_CHANNEL_PAUSE_JITTER_MS);
    expect(computeModelChannelPauseDueAt(until, () => Number.NaN).getTime()).toBe(until.getTime());
  });
});
