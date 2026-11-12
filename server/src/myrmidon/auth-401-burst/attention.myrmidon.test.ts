// myrmidon(OPE-11890): the auth-401 burst board-signal registry — pure, no
// database. The card exists exactly while the detector latch is set; a signal
// is recorded only from a tripped sample and carries no credential.

import { afterEach, describe, expect, it } from "vitest";
import {
  readAuth401BurstSignal,
  recordAuth401BurstSignal,
  resetAuth401BurstSignal,
  auth401BurstSignalDedupKey,
  auth401BurstSignalSeverity,
  auth401BurstSignalWhyNow,
  type Auth401BurstSignal,
} from "./attention.js";
import { createAuth401BurstMetrics } from "./metrics.js";

const BASE = 1_700_000_000_000;

function trippedSample(overrides: Partial<Parameters<typeof recordAuth401BurstSignal>[0]> = {}) {
  const m = createAuth401BurstMetrics({ threshold: 1, windowMs: 60_000 });
  m.record("no_credentials", BASE);
  const sample = m.read(BASE);
  return { ...sample, ...overrides };
}

afterEach(() => {
  resetAuth401BurstSignal();
});

describe("auth-401 burst signal registry", () => {
  it("records a signal from a tripped sample and reads it back", () => {
    recordAuth401BurstSignal(trippedSample());
    const signal = readAuth401BurstSignal();
    expect(signal).not.toBeNull();
    expect(signal!.tripped).toBe(true);
    expect(signal!.trippedAt).toBe(new Date(BASE).toISOString());
    expect(signal!.threshold).toBe(1);
    expect(signal!.windowMs).toBe(60_000);
    expect(signal!.windowTotal).toBe(1);
  });

  it("ignores an untripped sample — no card without a burst", () => {
    const m = createAuth401BurstMetrics({ threshold: 100, windowMs: 60_000 });
    m.record("no_credentials", BASE);
    recordAuth401BurstSignal(m.read(BASE));
    expect(readAuth401BurstSignal()).toBeNull();
  });

  it("the card disappears after reset (the operator/ADM clears the latch)", () => {
    recordAuth401BurstSignal(trippedSample());
    expect(readAuth401BurstSignal()).not.toBeNull();
    resetAuth401BurstSignal();
    expect(readAuth401BurstSignal()).toBeNull();
  });

  it("a later trip replaces the signal (re-trip after reset mints a new key)", () => {
    recordAuth401BurstSignal(trippedSample());
    const first = readAuth401BurstSignal()!;
    resetAuth401BurstSignal();
    const later = trippedSample({ trippedAt: new Date(BASE + 60_000).toISOString() });
    recordAuth401BurstSignal(later);
    const second = readAuth401BurstSignal()!;
    expect(auth401BurstSignalDedupKey(first)).not.toBe(auth401BurstSignalDedupKey(second));
  });

  it("severity is high — an active-auth stop", () => {
    expect(auth401BurstSignalSeverity()).toBe("high");
  });

  it("whyNow names threshold and window and never a credential", () => {
    recordAuth401BurstSignal(trippedSample());
    const text = auth401BurstSignalWhyNow(readAuth401BurstSignal()!);
    expect(text).toContain("threshold 1");
    expect(text).toContain("60s");
    expect(text).toContain("1 authentication 401s");
    expect(text).not.toContain("Bearer");
    expect(text).not.toContain("token=");
  });

  it("the signal carries only counts/threshold/window/trippedAt — no secret field", () => {
    recordAuth401BurstSignal(trippedSample());
    const signal = readAuth401BurstSignal()!;
    const keys = Object.keys(signal).sort();
    expect(keys).toEqual(["counts", "threshold", "tripped", "trippedAt", "windowMs", "windowTotal"]);
    expect(JSON.stringify(signal)).not.toContain("Bearer");
  });
});
