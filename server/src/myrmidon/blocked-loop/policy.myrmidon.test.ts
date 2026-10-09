// myrmidon(BLOCKED-LOOP): settings + pure policy + history shaping. No database.

import { describe, expect, it } from "vitest";
import { toBlockedLoopEvent } from "./history.js";
import {
  blockedLoopMessage,
  blockerSetKeyOf,
  descriptorKeyOf,
  judgeBlockedLoop,
  type BlockedLoopEvent,
} from "./policy.js";
import { DEFAULT_BLOCKED_LOOP_MAX_RETURNS, readBlockedLoopMaxReturns } from "./settings.js";

let tick = 0;
function at(): Date {
  tick += 1;
  return new Date(Date.UTC(2026, 9, 9, 0, 0, tick));
}
const attempt = { blockerSetKey: "a,b", descriptorKey: '{"action":"wait"}' };

function entered(overrides: Partial<BlockedLoopEvent> = {}): BlockedLoopEvent {
  return {
    createdAt: at(),
    actorType: "agent",
    kind: "entered_blocked",
    blockerSetKey: attempt.blockerSetKey,
    descriptorKey: attempt.descriptorKey,
    ...overrides,
  };
}
function left(overrides: Partial<BlockedLoopEvent> = {}): BlockedLoopEvent {
  return {
    createdAt: at(),
    actorType: "agent",
    kind: "left_blocked",
    blockerSetKey: null,
    descriptorKey: null,
    ...overrides,
  };
}
/** Oldest first: N cycles of enter + leave. */
function cycles(n: number, overrides: Partial<BlockedLoopEvent> = {}): BlockedLoopEvent[] {
  return Array.from({ length: n }, () => [entered(overrides), left()]).flat();
}

describe("readBlockedLoopMaxReturns", () => {
  it("defaults to 3 and accepts integers in 1..50 only", () => {
    expect(DEFAULT_BLOCKED_LOOP_MAX_RETURNS).toBe(3);
    expect(readBlockedLoopMaxReturns({})).toBe(3);
    expect(readBlockedLoopMaxReturns({ MYRMIDON_BLOCKED_LOOP_MAX_RETURNS: "5" })).toBe(5);
    expect(readBlockedLoopMaxReturns({ MYRMIDON_BLOCKED_LOOP_MAX_RETURNS: "1" })).toBe(1);
    expect(readBlockedLoopMaxReturns({ MYRMIDON_BLOCKED_LOOP_MAX_RETURNS: "50" })).toBe(50);
    for (const bad of ["0", "51", "-2", "2.5", "abc", ""]) {
      expect(readBlockedLoopMaxReturns({ MYRMIDON_BLOCKED_LOOP_MAX_RETURNS: bad })).toBe(3);
    }
  });
});

describe("judgeBlockedLoop", () => {
  it("allows the first N returns and rejects number N+1", () => {
    expect(judgeBlockedLoop(cycles(2), attempt, 3)).toEqual({ blockedLoop: false, streak: 2 });
    expect(judgeBlockedLoop(cycles(3), attempt, 3)).toEqual({ blockedLoop: true, streak: 3 });
    expect(judgeBlockedLoop(cycles(5), attempt, 3).blockedLoop).toBe(true);
  });

  it("does not depend on the order the rows arrive in", () => {
    expect(judgeBlockedLoop(cycles(3).reverse(), attempt, 3).blockedLoop).toBe(true);
  });

  it("a changed blocker set ends the streak", () => {
    const events = [...cycles(3, { blockerSetKey: "a" }), ...cycles(1)];
    expect(judgeBlockedLoop(events, attempt, 3)).toEqual({ blockedLoop: false, streak: 1 });
  });

  it("a different descriptor ends the streak", () => {
    const events = [...cycles(3, { descriptorKey: '{"action":"other"}' }), ...cycles(2)];
    expect(judgeBlockedLoop(events, attempt, 3)).toEqual({ blockedLoop: false, streak: 2 });
  });

  it("an entry with an unknown signature ends the streak", () => {
    const events = [...cycles(3, { blockerSetKey: null }), ...cycles(1)];
    expect(judgeBlockedLoop(events, attempt, 3).streak).toBe(1);
  });

  it("an action of a person ends the streak", () => {
    const events = [...cycles(3), left({ actorType: "user" }), ...cycles(1)];
    expect(judgeBlockedLoop(events, attempt, 3)).toEqual({ blockedLoop: false, streak: 1 });
    const humanEntry = [...cycles(3), entered({ actorType: "user" }), left(), ...cycles(1)];
    expect(judgeBlockedLoop(humanEntry, attempt, 3).streak).toBe(1);
  });

  it("settling the task (done, cancelled, in_review) ends the streak", () => {
    const settled: BlockedLoopEvent = {
      createdAt: at(),
      actorType: "agent",
      kind: "settled",
      blockerSetKey: null,
      descriptorKey: null,
    };
    const events = [...cycles(3), settled, ...cycles(1)];
    expect(judgeBlockedLoop(events, attempt, 3).streak).toBe(1);
  });

  it("with no history nothing is rejected", () => {
    expect(judgeBlockedLoop([], attempt, 1)).toEqual({ blockedLoop: false, streak: 0 });
  });

  it("with a limit of 1 the second return is rejected", () => {
    expect(judgeBlockedLoop(cycles(1), attempt, 1).blockedLoop).toBe(true);
  });
});

describe("signatures", () => {
  it("blocker set key ignores order and duplicates", () => {
    expect(blockerSetKeyOf(["b", "a", "b"])).toBe("a,b");
    expect(blockerSetKeyOf([])).toBe("");
  });

  it("descriptor key ignores property order and is null for none", () => {
    expect(descriptorKeyOf(null)).toBeNull();
    expect(descriptorKeyOf(undefined)).toBeNull();
    expect(descriptorKeyOf({ owner: { agentId: "x" }, action: "w" })).toBe(
      descriptorKeyOf({ action: "w", owner: { agentId: "x" } }),
    );
    expect(descriptorKeyOf({ action: "w" })).not.toBe(descriptorKeyOf({ action: "v" }));
  });

  it("the rejection message names the way out", () => {
    const message = blockedLoopMessage(3);
    expect(message).toContain("3 consecutive returns to blocked");
    expect(message).toContain("executionPolicy.monitor.nextCheckAt");
    expect(message).toContain("unblockDescriptor.reasonRef");
  });
});

describe("toBlockedLoopEvent", () => {
  const createdAt = new Date("2026-10-09T00:00:00Z");
  it("reads an entry with its recorded signature", () => {
    expect(
      toBlockedLoopEvent({
        createdAt,
        actorType: "agent",
        details: {
          changes: { status: { from: "in_progress", to: "blocked" } },
          blockedLoop: { blockerSetKey: "a", descriptorKey: "d" },
        },
      }),
    ).toEqual({
      createdAt,
      actorType: "agent",
      kind: "entered_blocked",
      blockerSetKey: "a",
      descriptorKey: "d",
    });
  });

  it("an entry recorded before the limiter has an unknown signature", () => {
    const event = toBlockedLoopEvent({
      createdAt,
      actorType: "agent",
      details: { changes: { status: { from: "todo", to: "blocked" } } },
    });
    expect(event?.blockerSetKey).toBeNull();
  });

  it("classifies exits and ignores everything else", () => {
    const exit = (to: string) =>
      toBlockedLoopEvent({
        createdAt,
        actorType: "agent",
        details: { changes: { status: { from: "blocked", to } } },
      })?.kind;
    expect(exit("todo")).toBe("left_blocked");
    expect(exit("in_progress")).toBe("left_blocked");
    expect(exit("done")).toBe("settled");
    expect(exit("cancelled")).toBe("settled");
    expect(exit("in_review")).toBe("settled");
    expect(
      toBlockedLoopEvent({
        createdAt,
        actorType: "agent",
        details: { changes: { status: { from: "todo", to: "in_progress" } } },
      }),
    ).toBeNull();
    expect(toBlockedLoopEvent({ createdAt, actorType: "agent", details: null })).toBeNull();
    expect(toBlockedLoopEvent({ createdAt, actorType: "agent", details: { changes: {} } })).toBeNull();
  });
});
