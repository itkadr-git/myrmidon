// myrmidon(OPE-11890): the auth-401 burst detector contract. These tests pin:
//  * threshold/window come from env with bounded defaults, and the SAME values
//    drive the counter and the trip latch (no two code paths disagree);
//  * the sliding window prunes old buckets (a quiet period clears the window
//    total even though the cumulative counter keeps growing);
//  * only the closed reason set becomes a label — an attacker-controlled
//    reason collapses to "unknown" and no fixture credential ever reaches a
//    label, the latch, or the sample.
//
// The module under test has no external imports, so it runs under
// `node --experimental-strip-types` as well as vitest.

import { describe, expect, it } from "vitest";
import {
  AUTH_401_REASONS,
  AUTH_401_BURST_THRESHOLD_ENV,
  AUTH_401_BURST_WINDOW_SEC_ENV,
  DEFAULT_AUTH_401_BURST_THRESHOLD,
  DEFAULT_AUTH_401_BURST_WINDOW_SEC,
  createAuth401BurstMetrics,
  readAuth401BurstSettings,
} from "./metrics.js";

const BASE = 1_700_000_000_000; // fixed epoch ms so bucket math is deterministic

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...overrides } as NodeJS.ProcessEnv;
}

describe("readAuth401BurstSettings", () => {
  it("defaults: threshold 20, window 60s", () => {
    expect(readAuth401BurstSettings(env())).toEqual({
      threshold: DEFAULT_AUTH_401_BURST_THRESHOLD,
      windowMs: DEFAULT_AUTH_401_BURST_WINDOW_SEC * 1000,
    });
    expect(DEFAULT_AUTH_401_BURST_THRESHOLD).toBe(20);
    expect(DEFAULT_AUTH_401_BURST_WINDOW_SEC).toBe(60);
  });

  it("reads threshold and window from env", () => {
    expect(
      readAuth401BurstSettings(
        env({ [AUTH_401_BURST_THRESHOLD_ENV]: "5", [AUTH_401_BURST_WINDOW_SEC_ENV]: "10" }),
      ),
    ).toEqual({ threshold: 5, windowMs: 10_000 });
  });

  it("clamps threshold and window to the documented bounds", () => {
    const s = readAuth401BurstSettings(
      env({ [AUTH_401_BURST_THRESHOLD_ENV]: "999999", [AUTH_401_BURST_WINDOW_SEC_ENV]: "99999" }),
    );
    expect(s.threshold).toBe(100_000);
    expect(s.windowMs).toBe(3_600_000);
  });

  it("non-numeric / non-positive env falls back to defaults", () => {
    expect(
      readAuth401BurstSettings(env({ [AUTH_401_BURST_THRESHOLD_ENV]: "abc", [AUTH_401_BURST_WINDOW_SEC_ENV]: "-1" })),
    ).toEqual({
      threshold: DEFAULT_AUTH_401_BURST_THRESHOLD,
      windowMs: DEFAULT_AUTH_401_BURST_WINDOW_SEC * 1000,
    });
  });
});

describe("createAuth401BurstMetrics — threshold/window", () => {
  it("trips exactly when the window total crosses the threshold", () => {
    const m = createAuth401BurstMetrics({ threshold: 3, windowMs: 60_000 });
    m.record("no_credentials", BASE);
    m.record("no_credentials", BASE + 1000);
    expect(m.read(BASE + 1000).tripped).toBe(false);
    m.record("agent_token_invalid", BASE + 2000);
    const s = m.read(BASE + 2000);
    expect(s.windowTotal).toBe(3);
    expect(s.tripped).toBe(true);
    expect(s.trippedAt).toBe(new Date(BASE + 2000).toISOString());
  });

  it("the latch stays set after the storm dies down (operator resets it)", () => {
    const m = createAuth401BurstMetrics({ threshold: 2, windowMs: 60_000 });
    m.record("no_credentials", BASE);
    m.record("no_credentials", BASE + 1000);
    expect(m.read(BASE + 1000).tripped).toBe(true);
    // Long after the window: total drains to 0 but the latch is still set.
    const later = m.read(BASE + 10 * 60_000);
    expect(later.windowTotal).toBe(0);
    expect(later.tripped).toBe(true);
  });

  it("the sliding window prunes buckets older than one window", () => {
    const m = createAuth401BurstMetrics({ threshold: 3, windowMs: 60_000 });
    // Two 401s now, one just inside the window edge, one just outside.
    m.record("no_credentials", BASE);
    m.record("no_credentials", BASE + 59_000);
    // At BASE+120s the first two buckets are pruned; windowTotal is 0 again.
    expect(m.read(BASE + 120_000).windowTotal).toBe(0);
  });

  it("reset clears counts, window, and the latch", () => {
    const m = createAuth401BurstMetrics({ threshold: 1, windowMs: 60_000 });
    m.record("no_credentials", BASE);
    expect(m.read(BASE).tripped).toBe(true);
    m.reset();
    const s = m.read(BASE);
    expect(s.tripped).toBe(false);
    expect(s.windowTotal).toBe(0);
    expect(s.trippedAt).toBeNull();
    expect(s.counts.no_credentials).toBe(0);
  });

  it("cumulative per-reason counts keep growing across the window prune", () => {
    const m = createAuth401BurstMetrics({ threshold: 100, windowMs: 60_000 });
    m.record("no_credentials", BASE);
    m.record("no_credentials", BASE + 120_000);
    const s = m.read(BASE + 120_000);
    expect(s.windowTotal).toBe(1); // only the newest bucket survives
    expect(s.counts.no_credentials).toBe(2); // cumulative is unaffected
  });
});

describe("createAuth401BurstMetrics — no-secret labels", () => {
  it("only the closed reason set is accepted; anything else collapses to unknown", () => {
    const m = createAuth401BurstMetrics({ threshold: 100, windowMs: 60_000 });
    for (const reason of AUTH_401_REASONS) m.record(reason, BASE);
    m.record("not_a_real_reason", BASE);
    // An attacker trying to inject a high-cardinality label shaped like a token:
    m.record("Bearer abcdef1234567890.super.secret.token", BASE);
    m.record({ reason: "no_credentials" }, BASE); // non-string collapses too

    const s = m.read(BASE);
    for (const reason of AUTH_401_REASONS) {
      if (reason === "unknown") continue; // counted below: 1 from the loop + 3 invalid
      expect(s.counts[reason]).toBe(1); // exactly one hit per closed-set reason
    }
    // Three invalid records above all collapse; plus the loop itself records
    // one "unknown" (it is a member of the closed set).
    expect(s.counts.unknown).toBe(4);
  });

  it("a credential-shaped reason never becomes a label or leaks into the sample", () => {
    const m = createAuth401BurstMetrics({ threshold: 1, windowMs: 60_000 });
    const secret = "sk-live-abcdef1234567890_NOT_A_REAL_KEY";
    m.record(secret, BASE);
    const s = m.read(BASE);
    const serialized = JSON.stringify(s);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("sk-live");
    // The whole serialized sample only ever mentions closed-set reason keys.
    for (const key of Object.keys(s.counts)) {
      expect(AUTH_401_REASONS).toContain(key);
    }
  });

  it("the reason set mirrors the auth middleware actorNoneReason taxonomy", () => {
    // Guard against the middleware and the metric label set drifting apart:
    // every 401-producing actorNoneReason must have a label (or collapse to
    // unknown), and public_path_bypass must NOT be a label.
    const expected = [
      "no_credentials",
      "session_resolution_error",
      "session_invalid",
      "agent_token_expired",
      "agent_token_invalid",
      "agent_token_agent_mismatch",
      "agent_token_agent_terminated",
      "agent_token_agent_pending",
      "agent_key_agent_mismatch",
      "agent_key_agent_terminated",
      "agent_key_agent_pending",
      "unknown",
    ];
    expect([...AUTH_401_REASONS]).toEqual(expected);
  });
});
