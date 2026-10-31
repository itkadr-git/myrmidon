// myrmidon(1.6.6 GUARDRAILS OPE-10182): unit tests for the guardrail trigger
// counter — the Prometheus seam of the guardrail layer. The counter is
// process-local (like the continuation and claim counters): record() ticks a
// rule x mode cell, read() returns a detached copy, reset() empties it, and
// bad input throws instead of silently corrupting the label space.

import { describe, expect, it } from "vitest";
import {
  GUARDRAIL_METRIC_MODES,
  GUARDRAIL_METRIC_RULES,
  createGuardrailTriggerMetrics,
} from "./metrics.js";

describe("guardrail trigger metrics counter", () => {
  it("counts triggers per rule and mode", () => {
    const counter = createGuardrailTriggerMetrics();
    counter.record("secret", "flag");
    counter.record("secret", "flag");
    counter.record("pii", "mask");
    counter.record("injection", "block");

    const counts = counter.read();
    expect(counts.secret.flag).toBe(2);
    expect(counts.pii.mask).toBe(1);
    expect(counts.injection.block).toBe(1);
    // every cell exists so the render loop always finds its series
    expect(counts.secret.block).toBe(0);
    expect(counts.injection.flag).toBe(0);
  });

  it("defaults to flag mode and accepts batch counts", () => {
    const counter = createGuardrailTriggerMetrics();
    counter.record("secret"); // mode defaults to flag
    counter.record("pii", "flag", 5);
    expect(counter.read().secret.flag).toBe(1);
    expect(counter.read().pii.flag).toBe(5);
  });

  it("read returns a detached copy", () => {
    const counter = createGuardrailTriggerMetrics();
    counter.record("secret", "flag");
    const first = counter.read();
    first.secret.flag = 999;
    counter.record("secret", "flag");
    expect(counter.read().secret.flag).toBe(2);
  });

  it("reset empties every cell", () => {
    const counter = createGuardrailTriggerMetrics();
    counter.record("secret", "flag");
    counter.reset();
    expect(counter.read().secret.flag).toBe(0);
  });

  it("rejects unknown rules, modes and counts", () => {
    const counter = createGuardrailTriggerMetrics();
    // @ts-expect-error — runtime guard against a future detector passing junk
    expect(() => counter.record("totes-new-rule", "flag")).toThrow(/rule/);
    // @ts-expect-error — runtime guard against a bad mode hint
    expect(() => counter.record("secret", "quarantine")).toThrow(/mode/);
    // @ts-expect-error — runtime guard against a non-integer or negative count
    expect(() => counter.record("secret", "flag", 1.5)).toThrow(/count/);
    // @ts-expect-error
    expect(() => counter.record("secret", "flag", -1)).toThrow(/count/);
    // nothing was counted by the rejected calls
    expect(counter.read().secret.flag).toBe(0);
  });

  it("exposes the closed label sets", () => {
    expect(GUARDRAIL_METRIC_RULES).toEqual(["secret", "pii", "injection"]);
    expect(GUARDRAIL_METRIC_MODES).toEqual(["flag", "mask", "block"]);
  });
});
