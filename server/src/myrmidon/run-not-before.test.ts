import { describe, expect, it } from "vitest";
import {
  RUN_NOT_BEFORE_CONTEXT_KEY,
  decideRunNotBefore,
  splitRunsHeldByNotBefore,
} from "./run-not-before.js";

// myrmidon(OPE-12929): deterministic coverage of the not-before gate — the
// boundary instant itself counts as reached (<=), every broken value keeps
// the pre-feature behavior, and the split drops held runs out of the claim
// pass in order.
const NOW = new Date("2026-11-13T12:00:00.000Z");

describe("decideRunNotBefore", () => {
  it("holds a run whose not-before instant is in the future", () => {
    const decision = decideRunNotBefore({
      contextSnapshot: { notBefore: "2026-11-13T12:00:01.000Z" },
      now: NOW,
    });
    expect(decision).toEqual({
      hold: true,
      notBefore: new Date("2026-11-13T12:00:01.000Z"),
    });
  });

  it("releases the run exactly at the boundary instant (inclusive)", () => {
    const decision = decideRunNotBefore({
      contextSnapshot: { notBefore: "2026-11-13T12:00:00.000Z" },
      now: NOW,
    });
    expect(decision).toEqual({ hold: false, reason: "reached" });
  });

  it("releases the run after the boundary instant", () => {
    const decision = decideRunNotBefore({
      contextSnapshot: { notBefore: "2026-11-13T11:59:59.999Z" },
      now: NOW,
    });
    expect(decision).toEqual({ hold: false, reason: "reached" });
  });

  it("compares time as a UTC instant across offsets", () => {
    // 14:00+02:00 is the same instant as 12:00Z — the boundary is reached.
    const decision = decideRunNotBefore({
      contextSnapshot: { notBefore: "2026-11-13T14:00:00.000+02:00" },
      now: NOW,
    });
    expect(decision).toEqual({ hold: false, reason: "reached" });
  });

  it("parses a date-only string as UTC midnight (a valid instant)", () => {
    // ES date-only forms are defined as UTC midnight, so they parse to a
    // real instant and the gate holds on them like any other future time.
    const futureDecision = decideRunNotBefore({
      contextSnapshot: { notBefore: "2026-11-14" },
      now: NOW,
    });
    expect(futureDecision).toEqual({
      hold: true,
      notBefore: new Date("2026-11-14T00:00:00.000Z"),
    });
    // The past-midnight form of the same string is simply reached.
    expect(
      decideRunNotBefore({
        contextSnapshot: { notBefore: "2026-11-13" },
        now: NOW,
      }),
    ).toEqual({ hold: false, reason: "reached" });
  });

  it.each([
    ["no key", {}],
    ["empty string", { notBefore: "" }],
    ["whitespace", { notBefore: "   " }],
    ["null", { notBefore: null }],
    ["number", { notBefore: 123 }],
  ])("never holds on a missing value (%s)", (_label, contextSnapshot) => {
    expect(decideRunNotBefore({ contextSnapshot, now: NOW })).toEqual({
      hold: false,
      reason: "missing",
    });
  });

  it.each([
    ["garbage", "not-a-date"],
    ["NaN date", "2026-13-45T99:99:99Z"],
    ["out-of-range hour", "2026-11-13T25:00:00Z"],
  ])("never holds on an unparsable value (%s)", (_label, notBefore) => {
    expect(
      decideRunNotBefore({ contextSnapshot: { notBefore }, now: NOW }),
    ).toEqual({ hold: false, reason: "invalid" });
  });

  it("does not hold a non-object context", () => {
    expect(decideRunNotBefore({ contextSnapshot: null, now: NOW })).toEqual({
      hold: false,
      reason: "missing",
    });
    expect(decideRunNotBefore({ contextSnapshot: "x", now: NOW })).toEqual({
      hold: false,
      reason: "missing",
    });
  });

  it("exports the context key it reads", () => {
    expect(RUN_NOT_BEFORE_CONTEXT_KEY).toBe("notBefore");
  });
});

describe("splitRunsHeldByNotBefore", () => {
  type Row = { id: string; contextSnapshot: unknown };

  const run = (id: string, notBefore?: string): Row => ({
    id,
    contextSnapshot: notBefore === undefined ? {} : { notBefore },
  });

  it("keeps runnable order and splits held runs with their remaining wait", () => {
    const rows: Row[] = [
      run("a", "2026-11-13T12:00:30.000Z"),
      run("b"),
      run("c", "2026-11-13T11:00:00.000Z"),
      run("d", "2026-11-13T12:00:10.000Z"),
    ];
    const split = splitRunsHeldByNotBefore(rows, { now: NOW });
    expect(split.runnable.map((r) => r.id)).toEqual(["b", "c"]);
    expect(split.held.map((h) => h.runId)).toEqual(["a", "d"]);
    expect(split.held[0]).toMatchObject({
      runId: "a",
      issueId: null,
      notBefore: new Date("2026-11-13T12:00:30.000Z"),
      remainingMs: 30_000,
    });
    expect(split.held[1]?.remainingMs).toBe(10_000);
    // The resweep arms at the earliest hold lift, not the latest.
    expect(split.resweepDelayMs).toBe(10_000);
  });

  it("carries the issue id for the log line", () => {
    const split = splitRunsHeldByNotBefore(
      [{ id: "x", contextSnapshot: { issueId: "iss-1", notBefore: "2026-11-13T13:00:00.000Z" } }],
      { now: NOW },
    );
    expect(split.held[0]?.issueId).toBe("iss-1");
  });

  it("returns everything runnable when no run carries a not-before", () => {
    const rows = [run("a"), run("b")];
    expect(splitRunsHeldByNotBefore(rows, { now: NOW })).toEqual({
      runnable: rows,
      held: [],
      resweepDelayMs: null,
    });
  });

  it("arms the resweep one tick before the earliest hold lift", () => {
    // `now` sits 1 ms before the earliest boundary: the run at the boundary
    // is still held (boundary = reached is exclusive in the hold direction)
    // and the resweep delay is the 1 ms left until it lifts — not the later
    // run's 5 s.
    const split = splitRunsHeldByNotBefore(
      [
        run("a", "2026-11-13T12:00:00.000Z"),
        run("d", "2026-11-13T12:00:05.000Z"),
      ],
      { now: new Date("2026-11-13T11:59:59.999Z") },
    );
    expect(split.held.map((h) => h.runId)).toEqual(["a", "d"]);
    expect(split.held[0]?.remainingMs).toBe(1);
    expect(split.resweepDelayMs).toBe(1);
  });
});
