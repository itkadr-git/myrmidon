// myrmidon(1.6.6 PROCS-0.1): the pulse — who writes a row, when, with what,
// and who deletes the rows of processes that are gone. Pins:
//   * a tick writes this process's row with the measurements of the tick;
//   * the reaper deletes rows older than the window, and only a role that owns
//     timers does it;
//   * start() refreshes the row immediately (the panel does not wait 10 s) and
//     then at the cadence; stop() ends it and a stopped pulse stays stopped;
//   * a failing tick is reported, never thrown — the board's own liveness
//     signal must not take the board down.

import { afterEach, describe, expect, it, vi } from "vitest";
import { BOARD_PROCESS_STALE_MS, resolveBoardProcessIdentity } from "./domain.js";
import { createBoardProcessPulse, type BoardProcessPulseFailurePhase } from "./pulse.js";
import type { BoardProcessIdentity } from "./domain.js";
import type { BoardProcessPulseUpdate, BoardProcessRow, BoardProcessStore } from "./store.js";

const AT = new Date("2026-10-08T12:00:00.000Z");
const START = new Date("2026-10-08T11:00:00.000Z");

function identity(role: "all" | "worker" | "api" = "all"): BoardProcessIdentity {
  return resolveBoardProcessIdentity({
    version: "1.6.6",
    role,
    bootId: "boot-a",
    pid: 42,
    hostname: "board-1",
    container: "ctr-a",
    startedAt: START,
    apiPort: 3100,
  });
}

function fakeStore(options: { failHeartbeat?: boolean; failDelete?: boolean; stale?: number } = {}) {
  const writes: Array<{ identity: BoardProcessIdentity; update: BoardProcessPulseUpdate; now: Date }> = [];
  const cuts: Date[] = [];
  const store: BoardProcessStore = {
    async heartbeat(nextIdentity, update, now) {
      if (options.failHeartbeat) throw new Error("database unavailable");
      writes.push({ identity: nextIdentity, update, now });
    },
    async listProcesses(): Promise<BoardProcessRow[]> {
      return [];
    },
    async deleteStale(cutoff) {
      if (options.failDelete) throw new Error("database unavailable");
      cuts.push(cutoff);
      return options.stale ?? 0;
    },
  };
  return { store, writes, cuts };
}

const metrics = () => ({ eventLoopLagMs: 12.5, rssBytes: 512_000_000 });

describe("board process pulse", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes this process's row with the measurements of the tick", async () => {
    const f = fakeStore();
    const pulse = createBoardProcessPulse({
      store: f.store,
      identity: identity(),
      readMetrics: metrics,
      now: () => AT,
    });

    await pulse.tick();

    expect(f.writes).toHaveLength(1);
    expect(f.writes[0].identity).toEqual(identity());
    expect(f.writes[0].update).toEqual({ eventLoopLagMs: 12.5, rssBytes: 512_000_000 });
    expect(f.writes[0].now).toBe(AT);
    expect(pulse.running).toBe(false);
  });

  it("deletes exactly the rows older than the window", async () => {
    const f = fakeStore({ stale: 2 });
    const pulse = createBoardProcessPulse({
      store: f.store,
      identity: identity("worker"),
      readMetrics: metrics,
      now: () => AT,
    });

    await pulse.tick();

    expect(f.cuts).toEqual([new Date(AT.getTime() - BOARD_PROCESS_STALE_MS)]);
    expect(await pulse.reapStale(AT)).toBe(2);
    expect(f.cuts).toHaveLength(2);
  });

  it("leaves reaping to the leader: an api process writes its row but deletes nothing", async () => {
    const f = fakeStore();
    const pulse = createBoardProcessPulse({
      store: f.store,
      identity: identity("api"),
      readMetrics: metrics,
      now: () => AT,
    });

    await pulse.tick();

    expect(f.writes).toHaveLength(1);
    expect(f.cuts).toEqual([]);
  });

  it("reaps when the caller says so even for an api role, and not when it is switched off", async () => {
    const forced = fakeStore();
    await createBoardProcessPulse({
      store: forced.store,
      identity: identity("api"),
      reap: true,
      readMetrics: metrics,
      now: () => AT,
    }).tick();
    expect(forced.cuts).toHaveLength(1);

    const off = fakeStore();
    await createBoardProcessPulse({
      store: off.store,
      identity: identity("all"),
      reap: false,
      readMetrics: metrics,
      now: () => AT,
    }).tick();
    expect(off.cuts).toEqual([]);
  });

  it("refreshes the row immediately at start, then at the cadence, and stops on stop()", async () => {
    vi.useFakeTimers();
    const f = fakeStore();
    const pulse = createBoardProcessPulse({
      store: f.store,
      identity: identity(),
      readMetrics: metrics,
      pulseMs: 50,
      now: () => new Date(),
    });

    pulse.start();
    expect(pulse.running).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.writes).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(50);
    expect(f.writes).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(50);
    expect(f.writes).toHaveLength(3);

    pulse.stop();
    expect(pulse.running).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(f.writes).toHaveLength(3);
  });

  it("does not stack a second timer when start() is called twice", async () => {
    vi.useFakeTimers();
    const f = fakeStore();
    const pulse = createBoardProcessPulse({
      store: f.store,
      identity: identity(),
      readMetrics: metrics,
      pulseMs: 50,
      now: () => new Date(),
    });

    pulse.start();
    pulse.start();
    await vi.advanceTimersByTimeAsync(50);
    expect(f.writes).toHaveLength(2);
    pulse.stop();
  });

  it("reports a failing write instead of throwing, and keeps ticking", async () => {
    vi.useFakeTimers();
    const failures: BoardProcessPulseFailurePhase[] = [];
    const f = fakeStore({ failHeartbeat: true });
    const pulse = createBoardProcessPulse({
      store: f.store,
      identity: identity(),
      readMetrics: metrics,
      pulseMs: 50,
      onError: (_error, phase) => failures.push(phase),
      now: () => new Date(),
    });

    pulse.start();
    // advanceTimersByTimeAsync resolves with the fake clock, so the proof of
    // "does not throw" is the await itself — the assertions are the failures.
    await vi.advanceTimersByTimeAsync(50);
    expect(failures).toEqual(["pulse", "pulse"]);
    expect(pulse.running).toBe(true);
    pulse.stop();
  });

  it("names a failing reaper separately from a failing write", async () => {
    const failures: BoardProcessPulseFailurePhase[] = [];
    const f = fakeStore({ failDelete: true });
    const pulse = createBoardProcessPulse({
      store: f.store,
      identity: identity(),
      readMetrics: metrics,
      onError: (_error, phase) => failures.push(phase),
      now: () => AT,
    });

    await pulse.tick();

    // The row was written before the reaper failed: the process stays visible.
    expect(f.writes).toHaveLength(1);
    expect(failures).toEqual(["reap"]);
  });
});