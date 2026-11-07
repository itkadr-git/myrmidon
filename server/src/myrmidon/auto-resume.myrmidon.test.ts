import { describe, expect, it } from "vitest";
import {
  AUTO_RESUME_BACKOFF_MS_ENV,
  AUTO_RESUME_ENABLED_ENV,
  AUTO_RESUME_INTERVAL_SEC_ENV,
  AUTO_RESUME_MAX_ATTEMPTS_ENV,
  AUTO_RESUME_METADATA_KEY,
  AUTO_RESUME_WINDOW_MS_ENV,
  DEFAULT_AUTO_RESUME_BACKOFF_MS,
  backoffForAttempt,
  decideAutoResume,
  mergeAutoResumeState,
  readAutoResumeAttentionState,
  readAutoResumeEnabled,
  readAutoResumeSettings,
  readAutoResumeState,
  type AutoResumeSettings,
  type AutoResumeState,
} from "./auto-resume.js";

// AUTO-RESUME (1.4): the board brings an agent left in `error` back with a
// 1/5/15 min backoff and stops with an operator card after the attempt cap.
const SETTINGS: AutoResumeSettings = {
  enabled: true,
  backoffMs: [60_000, 300_000, 900_000],
  maxAttempts: 3,
  intervalSec: 60,
  failureWindowMs: 60 * 60 * 1000,
};

const ENTRY = new Date("2026-10-02T00:00:00.000Z");

function at(offsetMs: number): Date {
  return new Date(ENTRY.getTime() + offsetMs);
}

function decide(overrides: Partial<Parameters<typeof decideAutoResume>[0]> = {}) {
  return decideAutoResume({
    agent: { status: "error", updatedAt: ENTRY },
    state: null,
    settings: SETTINGS,
    now: ENTRY,
    invokable: true,
    underMaintenance: false,
    ...overrides,
  });
}

describe("settings readers", () => {
  it("defaults to on unless an explicit off value is set", () => {
    expect(readAutoResumeEnabled({})).toBe(true);
    expect(readAutoResumeEnabled({ [AUTO_RESUME_ENABLED_ENV]: "garbage" })).toBe(true);
    for (const raw of ["0", "false", "off", "no", "OFF", " No "]) {
      expect(readAutoResumeEnabled({ [AUTO_RESUME_ENABLED_ENV]: raw }), raw).toBe(false);
    }
  });

  it("uses the 1/5/15 min default backoff, cap 3, per-minute sweep and a 1 h window", () => {
    const settings = readAutoResumeSettings({});
    expect(settings).toEqual({
      enabled: true,
      backoffMs: [...DEFAULT_AUTO_RESUME_BACKOFF_MS],
      maxAttempts: 3,
      intervalSec: 60,
      failureWindowMs: 60 * 60 * 1000,
    });
  });

  it("parses a custom backoff list and drops invalid entries", () => {
    expect(readAutoResumeSettings({ [AUTO_RESUME_BACKOFF_MS_ENV]: "1000, 2000,3000" }).backoffMs).toEqual([1000, 2000, 3000]);
    expect(readAutoResumeSettings({ [AUTO_RESUME_BACKOFF_MS_ENV]: "1000,abc,-5,0,2000" }).backoffMs).toEqual([1000, 2000]);
    expect(readAutoResumeSettings({ [AUTO_RESUME_BACKOFF_MS_ENV]: "garbage" }).backoffMs).toEqual([...DEFAULT_AUTO_RESUME_BACKOFF_MS]);
  });

  it("falls back to defaults for invalid cap/window and clamps the interval up", () => {
    expect(readAutoResumeSettings({ [AUTO_RESUME_MAX_ATTEMPTS_ENV]: "0" }).maxAttempts).toBe(3);
    expect(readAutoResumeSettings({ [AUTO_RESUME_MAX_ATTEMPTS_ENV]: "-1" }).maxAttempts).toBe(3);
    expect(readAutoResumeSettings({ [AUTO_RESUME_MAX_ATTEMPTS_ENV]: "5" }).maxAttempts).toBe(5);
    expect(readAutoResumeSettings({ [AUTO_RESUME_WINDOW_MS_ENV]: "abc" }).failureWindowMs).toBe(60 * 60 * 1000);
    expect(readAutoResumeSettings({ [AUTO_RESUME_WINDOW_MS_ENV]: "120000" }).failureWindowMs).toBe(120_000);
    // The legacy reader's historical clamp is still part of its public contract.
    expect(readAutoResumeSettings({ [AUTO_RESUME_INTERVAL_SEC_ENV]: "1" }).intervalSec).toBe(60);
    expect(readAutoResumeSettings({ [AUTO_RESUME_INTERVAL_SEC_ENV]: "300" }).intervalSec).toBe(300);
  });
});

describe("backoffForAttempt", () => {
  it("walks the steps and repeats the last one", () => {
    const backoff = [1000, 5000, 15000];
    expect(backoffForAttempt(backoff, 0)).toBe(1000);
    expect(backoffForAttempt(backoff, 1)).toBe(5000);
    expect(backoffForAttempt(backoff, 2)).toBe(15000);
    expect(backoffForAttempt(backoff, 9)).toBe(15000);
    expect(backoffForAttempt([], 0)).toBe(DEFAULT_AUTO_RESUME_BACKOFF_MS[0]);
  });
});

describe("state codec", () => {
  it("round-trips through metadata and preserves other keys", () => {
    const state: AutoResumeState = {
      failures: 2,
      lastFailureAt: ENTRY.toISOString(),
      nextAttemptAt: at(300_000).toISOString(),
      exhaustedAt: null,
      lastResumeAt: ENTRY.toISOString(),
    };
    const metadata = mergeAutoResumeState({ existing: "keep" }, state);
    expect(metadata.existing).toBe("keep");
    expect(readAutoResumeState(metadata)).toEqual(state);

    const cleared = mergeAutoResumeState(metadata, null);
    expect(cleared.existing).toBe("keep");
    expect(AUTO_RESUME_METADATA_KEY in cleared).toBe(false);
    expect(readAutoResumeState(cleared)).toBeNull();
  });

  it("ignores malformed state", () => {
    expect(readAutoResumeState(null)).toBeNull();
    expect(readAutoResumeState("nope")).toBeNull();
    expect(readAutoResumeState({ [AUTO_RESUME_METADATA_KEY]: { failures: 1 } })).toBeNull();
    expect(readAutoResumeState({ [AUTO_RESUME_METADATA_KEY]: "x" })).toBeNull();
  });

  it("exposes the attention slice", () => {
    expect(readAutoResumeAttentionState({})).toBeNull();
    const metadata = mergeAutoResumeState(null, {
      failures: 3,
      lastFailureAt: ENTRY.toISOString(),
      nextAttemptAt: null,
      exhaustedAt: at(1_000).toISOString(),
      lastResumeAt: ENTRY.toISOString(),
    });
    expect(readAutoResumeAttentionState(metadata)).toEqual({
      exhausted: true,
      failures: 3,
      exhaustedAt: at(1_000).toISOString(),
    });
  });
});

describe("decideAutoResume policy", () => {
  it("skips without the gates", () => {
    expect(decide({ settings: { ...SETTINGS, enabled: false } })).toMatchObject({ action: "skip", reason: "disabled" });
    expect(decide({ agent: { status: "idle", updatedAt: ENTRY } })).toMatchObject({ action: "skip", reason: "not_error" });
    expect(decide({ invokable: false })).toMatchObject({ action: "skip", reason: "not_invokable" });
    expect(decide({ underMaintenance: true })).toMatchObject({ action: "skip", reason: "maintenance" });
    expect(decide({ agent: { status: "error", errorReason: "контейнер не поднят", updatedAt: ENTRY } })).toMatchObject({
      action: "skip",
      reason: "container_not_started",
    });
  });

  it("waits one minute after the error entry, then resumes on the 1/5/15 steps", () => {
    // Before the first step: nothing yet.
    expect(decide({ now: at(59_000) })).toMatchObject({ action: "skip", reason: "not_due" });

    // First attempt at +1 min.
    const first = decide({ now: at(60_000) });
    expect(first.action).toBe("resume");
    expect(first.nextState).toMatchObject({
      failures: 1,
      lastFailureAt: at(60_000).toISOString(),
      nextAttemptAt: at(60_000 + 300_000).toISOString(),
      exhaustedAt: null,
    });

    // Second attempt: 5 min after the first.
    expect(decide({ state: first.nextState, now: at(60_000 + 299_000) })).toMatchObject({ action: "skip", reason: "not_due" });
    const second = decide({ state: first.nextState, now: at(60_000 + 300_000) });
    expect(second.action).toBe("resume");
    expect(second.nextState).toMatchObject({
      failures: 2,
      nextAttemptAt: at(60_000 + 300_000 + 900_000).toISOString(),
    });

    // Third attempt: 15 min after the second.
    const thirdAt = 60_000 + 300_000 + 900_000;
    const third = decide({ state: second.nextState, now: at(thirdAt) });
    expect(third.action).toBe("resume");
    expect(third.nextState).toMatchObject({ failures: 3, exhaustedAt: null });

    // Cap reached: give up immediately, no further wait.
    const exhausted = decide({ state: third.nextState, now: at(thirdAt + 1) });
    expect(exhausted.action).toBe("exhaust");
    expect(exhausted.reason).toBe("max_attempts");
    expect(exhausted.nextState?.exhaustedAt).toBe(at(thirdAt + 1).toISOString());
    expect(exhausted.nextState?.failures).toBe(3);

    // And it stays given up.
    expect(decide({ state: exhausted.nextState, now: at(thirdAt + 60 * 60 * 1000) })).toMatchObject({
      action: "skip",
      reason: "exhausted",
    });
  });

  it("honours a custom attempt cap", () => {
    const settings: AutoResumeSettings = { ...SETTINGS, maxAttempts: 1 };
    const first = decide({ settings, now: at(60_000) });
    expect(first.action).toBe("resume");
    expect(decide({ settings, state: first.nextState, now: at(120_000) })).toMatchObject({ action: "exhaust" });
  });

  const EXHAUSTED: AutoResumeState = {
    failures: 3,
    lastFailureAt: at(60_000).toISOString(),
    nextAttemptAt: null,
    exhaustedAt: at(1_200_000).toISOString(),
    lastResumeAt: at(60_000).toISOString(),
  };

  it("re-arms a give-up only when an operator acted after it (OPE-11947)", () => {
    // Nobody acted: still given up.
    expect(decide({ state: EXHAUSTED, now: at(1_300_000) })).toMatchObject({ action: "skip", reason: "exhausted" });

    // An operator action older than the give-up does not re-arm it.
    expect(
      decide({ state: EXHAUSTED, now: at(1_300_000), lastOperatorActionAt: at(600_000) }),
    ).toMatchObject({ action: "skip", reason: "exhausted" });

    // The operator resumed/updated the agent afterwards: a new episode.
    const rearmed = decide({
      state: EXHAUSTED,
      now: at(3_600_000),
      agent: { status: "error", updatedAt: at(3_000_000) },
      lastOperatorActionAt: at(3_000_000),
    });
    expect(rearmed.action).toBe("resume");
    expect(rearmed.nextState).toMatchObject({ failures: 1, exhaustedAt: null });
  });

  it("does not re-arm a give-up because agents.updated_at moved (runs and status changes move it)", () => {
    // A system touch five minutes after the give-up: the old rule re-armed here.
    expect(
      decide({
        state: EXHAUSTED,
        now: at(3_600_000),
        agent: { status: "error", updatedAt: at(1_500_000) },
        lastOperatorActionAt: null,
      }),
    ).toMatchObject({ action: "skip", reason: "exhausted", nextState: EXHAUSTED });
  });

  // myrmidon(OPE-11947): an agent whose last finished run is model-unavailable
  // returns on the long schedule 30 min, 1 h, 2 h, 4 h, 6 h, 6 h ... counted from
  // the end of that run, outside the attempt cap.
  const MIN = 60_000;
  const LONG_DELAYS_MIN = [30, 60, 120, 240, 360, 360, 360, 360, 360, 360, 360, 360];

  it("waits for a model-unavailable agent until 30 minutes after its last run ended", () => {
    const finishedAt = at(10 * MIN);
    const before = decide({
      now: at(10 * MIN + 30 * MIN - 1),
      lastRunModelUnavailable: true,
      lastRunFinishedAt: finishedAt,
    });
    expect(before).toMatchObject({ action: "skip", reason: "model_unavailable_wait", nextState: null });
    // The ordinary 1/5/15 min backoff would have resumed long ago.
    expect(decide({ now: at(10 * MIN + 30 * MIN - 1), lastRunModelUnavailable: false })).toMatchObject({
      action: "resume",
    });

    const due = decide({
      now: at(10 * MIN + 30 * MIN),
      lastRunModelUnavailable: true,
      lastRunFinishedAt: finishedAt,
    });
    expect(due).toMatchObject({ action: "resume", reason: "model_unavailable_due" });
    // Not an attempt of the capped streak.
    expect(due.nextState).toMatchObject({ failures: 0, exhaustedAt: null, modelUnavailableResumes: 1 });
  });

  it("grows the wait 30 min, 1 h, 2 h, 4 h, 6 h and never gives up, even after ten series", () => {
    let state: AutoResumeState | null = null;
    let finishedAt = at(0);
    for (const [index, minutes] of LONG_DELAYS_MIN.entries()) {
      // One millisecond early: still waiting.
      const early = decide({
        state,
        now: new Date(finishedAt.getTime() + minutes * MIN - 1),
        lastRunModelUnavailable: true,
        lastRunFinishedAt: finishedAt,
      });
      expect(early).toMatchObject({ action: "skip", reason: "model_unavailable_wait" });

      // On the step: resume, and never exhaust, however many series went before.
      const now: Date = new Date(finishedAt.getTime() + minutes * MIN);
      const due = decide({ state, now, lastRunModelUnavailable: true, lastRunFinishedAt: finishedAt });
      expect(due.action).toBe("resume");
      expect(due.reason).toBe("model_unavailable_due");
      expect(due.nextState).toMatchObject({
        failures: 0,
        exhaustedAt: null,
        modelUnavailableResumes: index + 1,
      });

      // The resumed agent fails on the same quota at once: the next series starts from that run.
      state = due.nextState;
      finishedAt = now;
    }
    expect(state?.modelUnavailableResumes).toBe(LONG_DELAYS_MIN.length);
    expect(state?.failures).toBe(0);
  });

  it("does not wake a model-unavailable agent sooner than one step after the last resume", () => {
    const resumed: AutoResumeState = {
      failures: 0,
      lastFailureAt: at(60 * MIN).toISOString(),
      nextAttemptAt: null,
      exhaustedAt: null,
      lastResumeAt: at(60 * MIN).toISOString(),
      modelUnavailableResumes: 1,
    };
    // The run that failed is older than the resume (no new run since): count from the resume.
    expect(
      decide({
        state: resumed,
        now: at(60 * MIN + 59 * MIN),
        lastRunModelUnavailable: true,
        lastRunFinishedAt: at(0),
      }),
    ).toMatchObject({ action: "skip", reason: "model_unavailable_wait" });
    expect(
      decide({
        state: resumed,
        now: at(60 * MIN + 60 * MIN),
        lastRunModelUnavailable: true,
        lastRunFinishedAt: at(0),
      }),
    ).toMatchObject({ action: "resume", reason: "model_unavailable_due" });
  });

  it("starts a new series after a healthy stretch instead of keeping a stale counter", () => {
    const stale: AutoResumeState = {
      failures: 0,
      lastFailureAt: at(0).toISOString(),
      nextAttemptAt: null,
      exhaustedAt: null,
      lastResumeAt: at(0).toISOString(),
      modelUnavailableResumes: 4,
    };
    // The next model-unavailable run ended 7 h after the last resume: a fresh series, 30 min.
    const finishedAt = at(7 * 60 * MIN);
    expect(
      decide({
        state: stale,
        now: new Date(finishedAt.getTime() + 30 * MIN - 1),
        lastRunModelUnavailable: true,
        lastRunFinishedAt: finishedAt,
      }),
    ).toMatchObject({ action: "skip", reason: "model_unavailable_wait" });
    const due = decide({
      state: stale,
      now: new Date(finishedAt.getTime() + 30 * MIN),
      lastRunModelUnavailable: true,
      lastRunFinishedAt: finishedAt,
    });
    expect(due).toMatchObject({ action: "resume" });
    expect(due.nextState?.modelUnavailableResumes).toBe(1);
  });

  it("returns to the ordinary backoff and cap once the last run is not model-unavailable", () => {
    const series: AutoResumeState = {
      failures: 0,
      lastFailureAt: at(0).toISOString(),
      nextAttemptAt: null,
      exhaustedAt: null,
      lastResumeAt: at(0).toISOString(),
      modelUnavailableResumes: 5,
    };
    // Another error: the series counter is dropped, the streak starts at attempt one.
    const first = decide({ state: series, now: at(10 * MIN), lastRunModelUnavailable: false });
    expect(first).toMatchObject({ action: "resume", reason: "due" });
    expect(first.nextState).toMatchObject({ failures: 1 });
    expect(first.nextState?.modelUnavailableResumes).toBeUndefined();

    // And it gives up after the cap again.
    let state = first.nextState;
    let nowMs = 10 * MIN;
    for (let attempt = 2; attempt <= SETTINGS.maxAttempts; attempt += 1) {
      nowMs += 30 * MIN;
      const next = decide({ state, now: at(nowMs), lastRunModelUnavailable: false });
      expect(next.action).toBe("resume");
      state = next.nextState;
    }
    nowMs += MIN;
    expect(decide({ state, now: at(nowMs), lastRunModelUnavailable: false })).toMatchObject({
      action: "exhaust",
      reason: "max_attempts",
    });
  });

  it("round-trips the series counter and drops a malformed one", () => {
    const state: AutoResumeState = {
      failures: 0,
      lastFailureAt: ENTRY.toISOString(),
      nextAttemptAt: null,
      exhaustedAt: null,
      lastResumeAt: ENTRY.toISOString(),
      modelUnavailableResumes: 3,
    };
    expect(readAutoResumeState(mergeAutoResumeState(null, state))).toEqual(state);
    const malformed = mergeAutoResumeState(null, { ...state, modelUnavailableResumes: -2 });
    expect(readAutoResumeState(malformed)?.modelUnavailableResumes).toBeUndefined();
  });

  it("drops a streak whose last failure is older than the window", () => {
    const stale: AutoResumeState = {
      failures: 2,
      lastFailureAt: at(0).toISOString(),
      nextAttemptAt: at(300_000).toISOString(),
      exhaustedAt: null,
      lastResumeAt: at(0).toISOString(),
    };
    // Inside the window the streak continues (the cap is not reset).
    expect(decide({ state: stale, now: at(900_000) })).toMatchObject({ action: "resume" });
    // Past the window it is a fresh episode: failures start at one again.
    const fresh = decide({ state: stale, now: at(60 * 60 * 1000 + 1) });
    expect(fresh.action).toBe("resume");
    expect(fresh.nextState?.failures).toBe(1);
  });

  it("never resumes a non-error agent even with a due state", () => {
    const due: AutoResumeState = {
      failures: 1,
      lastFailureAt: at(0).toISOString(),
      nextAttemptAt: at(300_000).toISOString(),
      exhaustedAt: null,
      lastResumeAt: at(0).toISOString(),
    };
    expect(decide({ state: due, agent: { status: "idle", updatedAt: ENTRY }, now: at(600_000) })).toMatchObject({
      action: "skip",
      reason: "not_error",
    });
  });
});