// myrmidon(PROCS-1.2): unit tests of the process supervisor against the
// design's §7.1/§7.2 contract. The children here are fakes — the real fork and
// the real listener belong to the integration lane — but every state the
// operator can put the board into is exercised: single→split with readiness,
// apiCount up/down with drain, split→single, a crash with the backoff ladder,
// and the emergency fallback to single.
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import {
  DEFAULT_PROCESSES_SETTINGS,
  type ProcessesSettings,
} from "@paperclipai/shared";
import {
  createProcessSupervisor,
  SUPERVISOR_BACKOFF_INITIAL_MS,
  SUPERVISOR_DRAIN_GRACE_MS,
  SUPERVISOR_IPC_DRAIN,
  SUPERVISOR_IPC_READY,
  SUPERVISOR_NO_CHILD_GRACE_MS,
  type ProcessSupervisorDeps,
  type SupervisorListenerHandle,
} from "./supervisor.js";

function settings(patch: Partial<ProcessesSettings> = {}): ProcessesSettings {
  return {
    ...DEFAULT_PROCESSES_SETTINGS,
    mode: "split",
    apiCount: 2,
    ...patch,
  };
}

class FakeChild extends EventEmitter {
  pid = Math.floor(Math.random() * 100_000) + 100;
  exitCode: number | null = null;
  signalCode: string | null = null;
  sent: unknown[] = [];
  killed: string[] = [];
  send = vi.fn((message: unknown) => {
    this.sent.push(message);
    return true;
  });
  kill = vi.fn((signal?: string) => {
    this.killed.push(signal ?? "SIGTERM");
    return true;
  });
  asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

interface FakeClock {
  timers: Array<{ fn: () => void; at: number; id: number }>;
  nowMs: number;
  setTimeout: ProcessSupervisorDeps["setTimeout"];
  clearTimeout: ProcessSupervisorDeps["clearTimeout"];
  advance(ms: number): void;
}

function fakeClock(start = 0): FakeClock {
  let nextId = 1;
  const clock: FakeClock = {
    timers: [],
    nowMs: start,
    setTimeout: ((fn: () => void, ms: number) => {
      const id = nextId++;
      clock.timers.push({ fn, at: clock.nowMs + ms, id });
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as ProcessSupervisorDeps["setTimeout"],
    clearTimeout: ((id: unknown) => {
      clock.timers = clock.timers.filter((t) => t.id !== id);
    }) as ProcessSupervisorDeps["clearTimeout"],
    advance(ms: number) {
      const until = clock.nowMs + ms;
      // Drain callbacks can schedule or cancel timers; rebuild the due list
      // every pass so cascades land in order.
      for (;;) {
        const due = clock.timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at);
        if (due.length === 0) break;
        const next = due[0];
        clock.timers = clock.timers.filter((t) => t.id !== next.id);
        clock.nowMs = next.at;
        next.fn();
      }
      clock.nowMs = until;
    },
  };
  return clock;
}

function fakeListener(): SupervisorListenerHandle & { closed: boolean; idleClosed: number; allClosed: number } {
  const state = { closed: false, idleClosed: 0, allClosed: 0 };
  return {
    ...state,
    get closed() { return state.closed; },
    get idleClosed() { return state.idleClosed; },
    get allClosed() { return state.allClosed; },
    listening: true,
    close: async () => { state.closed = true; },
    closeIdleConnections: () => { state.idleClosed += 1; },
    closeAllConnections: () => { state.allClosed += 1; },
  } as SupervisorListenerHandle & { closed: boolean; idleClosed: number; allClosed: number };
}

function makeSupervisor(overrides: Partial<ProcessSupervisorDeps> = {}) {
  const clock = fakeClock();
  const children: FakeChild[] = [];
  const listeners: Array<ReturnType<typeof fakeListener>> = [];
  const attention: Array<Record<string, unknown>> = [];
  const logLines: Array<{ level: string; f: object; m: string }> = [];
  const supervisor = createProcessSupervisor({
    forkChild: () => {
      const child = new FakeChild();
      children.push(child);
      return child.asChildProcess();
    },
    openPublicListener: async () => {
      const listener = fakeListener();
      listeners.push(listener);
      return listener;
    },
    drainPublicListener: async (handle, graceMs) => {
      // close() + closeIdleConnections() now; closeAllConnections() after the
      // grace — mirrors the worker drain in index.ts and the child drain.
      await handle.close();
      handle.closeIdleConnections();
      const force = clock.setTimeout(() => {
        handle.closeAllConnections();
      }, graceMs);
      force.unref?.();
    },
    writeAttentionSignal: (details) => {
      attention.push(details);
    },
    log: {
      debug: (f: object, m: string) => logLines.push({ level: "debug", f, m }),
      info: (f: object, m: string) => logLines.push({ level: "info", f, m }),
      warn: (f: object, m: string) => logLines.push({ level: "warn", f, m }),
      error: (f: object, m: string) => logLines.push({ level: "error", f, m }),
    },
    now: () => clock.nowMs,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    ...overrides,
  });
  return { supervisor, children, listeners, attention, clock, logLines };
}

describe("process supervisor (PROCS-1.2)", () => {
  it("stays inert in single mode — no fork, no listener churn", async () => {
    const { supervisor, children, listeners } = makeSupervisor();
    await supervisor.apply(settings({ mode: "single" }));
    expect(supervisor.state()).toBe("single");
    expect(children).toHaveLength(0);
    // One listener — the worker's own, opened once by the first apply — and
    // it stays open. A no-op single mode never forks and never closes it.
    expect(listeners).toHaveLength(1);
    expect(listeners[0].closed).toBe(false);
    // A repeat apply is a no-op: no second listener, no fork.
    await supervisor.apply(settings({ mode: "single" }));
    expect(listeners).toHaveLength(1);
    expect(children).toHaveLength(0);
  });

  it("single→split forks apiCount children and closes the worker's public listener once all are ready", async () => {
    const { supervisor, children, listeners } = makeSupervisor();
    // The worker started in single with its own listener open: first apply(single) opens it.
    await supervisor.apply(settings({ mode: "single" }));
    expect(listeners).toHaveLength(1);
    const workerListener = listeners[0];
    await supervisor.apply(settings({ mode: "split", apiCount: 2 }));
    expect(children).toHaveLength(2);
    // Not yet ready — the worker keeps serving.
    expect(workerListener.closed).toBe(false);
    children[0].emit("message", { type: SUPERVISOR_IPC_READY });
    expect(workerListener.closed).toBe(false);
    children[1].emit("message", { type: SUPERVISOR_IPC_READY });
    // Let the async close land.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(supervisor.state()).toBe("split");
    expect(workerListener.closed).toBe(true);
    expect(workerListener.idleClosed).toBe(1);
    expect(listeners).toHaveLength(1); // no emergency listener was opened
  });

  it("apiCount down drains the surplus children over IPC with the grace", async () => {
    const { supervisor, children, clock } = makeSupervisor();
    await supervisor.apply(settings({ mode: "split", apiCount: 3 }));
    expect(children).toHaveLength(3);
    // Get to steady split first.
    for (const child of children) child.emit("message", { type: SUPERVISOR_IPC_READY });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await supervisor.apply(settings({ mode: "split", apiCount: 1 }));
    const drains = children.filter((c) => c.sent.some((m) => (m as { type?: string }).type === SUPERVISOR_IPC_DRAIN));
    expect(drains).toHaveLength(2);
    expect(drains[0].sent[0]).toMatchObject({ type: SUPERVISOR_IPC_DRAIN, graceMs: SUPERVISOR_DRAIN_GRACE_MS });
    // The kill backstop is armed for the drained slots.
    clock.advance(SUPERVISOR_DRAIN_GRACE_MS * 2);
    expect(drains.every((c) => c.killed.includes("SIGTERM"))).toBe(true);
  });

  it("apiCount up forks the missing children", async () => {
    const { supervisor, children } = makeSupervisor();
    await supervisor.apply(settings({ mode: "split", apiCount: 1 }));
    children[0].emit("message", { type: SUPERVISOR_IPC_READY });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await supervisor.apply(settings({ mode: "split", apiCount: 3 }));
    expect(children).toHaveLength(3);
  });

  it("split→single re-opens the worker listener and drains every child", async () => {
    const { supervisor, children, listeners } = makeSupervisor();
    await supervisor.apply(settings({ mode: "split", apiCount: 2 }));
    await supervisor.apply(settings({ mode: "single" }));
    expect(supervisor.state()).toBe("single");
    expect(listeners).toHaveLength(1); // worker re-opened its public listener
    const drains = children.filter((c) => c.sent.some((m) => (m as { type?: string }).type === SUPERVISOR_IPC_DRAIN));
    expect(drains).toHaveLength(2);
  });

  it("a crashed child restarts with the 1s→30s backoff ladder", async () => {
    const { supervisor, children, clock } = makeSupervisor();
    await supervisor.apply(settings({ mode: "split", apiCount: 1 }));
    expect(children).toHaveLength(1);
    children[0].exitCode = 1;
    children[0].emit("exit", 1, null);
    clock.advance(SUPERVISOR_BACKOFF_INITIAL_MS);
    expect(children).toHaveLength(2); // restarted after 1s
    children[1].exitCode = 1;
    children[1].emit("exit", 1, null);
    clock.advance(SUPERVISOR_BACKOFF_INITIAL_MS * 2 - 1);
    expect(children).toHaveLength(2); // 2s not elapsed yet
    clock.advance(1);
    expect(children).toHaveLength(3);
  });

  it("with no live child for the grace window the worker opens :3100 itself and raises the attention signal", async () => {
    const { supervisor, children, listeners, attention, clock } = makeSupervisor();
    await supervisor.apply(settings({ mode: "split", apiCount: 2 }));
    // The children get ready, then both die. The supervisor arms the no-child
    // grace; with the fake clock we let the backoff restart fire first, kill
    // the replacement immediately (so there is never a live child for the
    // whole grace window), then run the clock past the grace.
    children[0].emit("message", { type: SUPERVISOR_IPC_READY });
    children[1].emit("message", { type: SUPERVISOR_IPC_READY });
    await new Promise((r) => setImmediate(r));
    expect(supervisor.state()).toBe("split");

    children[0].exitCode = 1;
    children[0].emit("exit", 1, null);
    children[1].exitCode = 1;
    children[1].emit("exit", 1, null);
    // Backoff restarts both after 1s — kill every replacement right away so
    // the "no live child" window never closes. The grace is 15s, so we drive
    // the fake clock forward in 1s steps, crashing every freshly-forked
    // replacement, until the grace expires and the supervisor falls back.
    for (let round = 0; round < 25; round += 1) {
      const before = children.length;
      clock.advance(1_000); // let any due backoff fire
      for (let i = before; i < children.length; i += 1) {
        children[i].exitCode = 1;
        children[i].emit("exit", 1, null);
      }
      if (supervisor.state() === "emergencySingle") break;
    }
    expect(supervisor.state()).toBe("emergencySingle");
    expect(listeners).toHaveLength(1);
    expect(attention).toHaveLength(1);
    expect(attention[0]).toMatchObject({ reason: "no_live_api_children" });
  });

  it("shutdown SIGTERMs every live child and stops restarts", async () => {
    const { supervisor, children, clock } = makeSupervisor();
    await supervisor.apply(settings({ mode: "split", apiCount: 2 }));
    children[0].exitCode = 1;
    children[0].emit("exit", 1, null);
    await supervisor.shutdown();
    const live = children.filter((c) => c.exitCode === null);
    // The still-running child was killed; the crashed one was already gone.
    expect(children[1].killed).toContain("SIGTERM");
    // The pending restart of child[0] must not fire after shutdown.
    clock.advance(60_000);
    expect(children).toHaveLength(2);
  });
});
