// myrmidon(OPE-12808): a run interrupted by the stall sweep may still act for a
// bounded grace; afterwards the refusal names the stall.

import { describe, expect, it } from "vitest";
import { RUN_STALL_ERROR_CODE } from "./constants.js";
import {
  decideRunActing,
  readRunStallGraceMs,
  runStallRefusalDetails,
  RUN_STALL_GRACE_ENV,
} from "./grace.js";

const NOW = new Date("2026-11-12T06:00:00.000Z");
const stalledAt = (agoMs: number) => ({
  status: "cancelled",
  errorCode: RUN_STALL_ERROR_CODE,
  finishedAt: new Date(NOW.getTime() - agoMs),
  updatedAt: null,
});

describe("run stall grace", () => {
  it("lets a live run act", () => {
    expect(decideRunActing({ status: "running", errorCode: null, finishedAt: null, updatedAt: null }, NOW, 600_000)).toEqual({
      kind: "active",
    });
  });

  it("keeps a stalled-and-cancelled run able to act inside the grace", () => {
    const decision = decideRunActing(stalledAt(60_000), NOW, 600_000);
    expect(decision).toEqual({ kind: "stall_grace", graceLeftMs: 540_000 });
  });

  it("names the stall once the grace is spent", () => {
    const decision = decideRunActing(stalledAt(601_000), NOW, 600_000);
    expect(decision.kind).toBe("stall_expired");
  });

  it("turns the grace off with a zero window", () => {
    expect(decideRunActing(stalledAt(1), NOW, 0).kind).toBe("stall_expired");
  });

  it("falls back to updatedAt when finishedAt is missing, and refuses when neither is known", () => {
    const run = { ...stalledAt(0), finishedAt: null, updatedAt: new Date(NOW.getTime() - 5_000) };
    expect(decideRunActing(run, NOW, 600_000).kind).toBe("stall_grace");
    expect(decideRunActing({ ...run, updatedAt: null }, NOW, 600_000).kind).toBe("stall_expired");
  });

  it("does not extend the grace to runs cancelled for any other reason", () => {
    expect(decideRunActing({ ...stalledAt(1000), errorCode: "cancelled_by_user" }, NOW, 600_000).kind).toBe("inactive");
    expect(decideRunActing({ ...stalledAt(1000), status: "failed" }, NOW, 600_000).kind).toBe("inactive");
  });

  it("reads the grace from the environment with a safe default", () => {
    expect(readRunStallGraceMs({})).toBe(600_000);
    expect(readRunStallGraceMs({ [RUN_STALL_GRACE_ENV]: "120" })).toBe(120_000);
    expect(readRunStallGraceMs({ [RUN_STALL_GRACE_ENV]: "0" })).toBe(0);
    expect(readRunStallGraceMs({ [RUN_STALL_GRACE_ENV]: "junk" })).toBe(600_000);
    expect(readRunStallGraceMs({ [RUN_STALL_GRACE_ENV]: "-5" })).toBe(600_000);
  });

  it("carries a machine-readable code in the refusal", () => {
    expect(runStallRefusalDetails("r1", NOW, 600_000)).toMatchObject({
      code: "run_stalled",
      runId: "r1",
      interruptedAt: NOW.toISOString(),
      graceSec: 600,
    });
  });
});
