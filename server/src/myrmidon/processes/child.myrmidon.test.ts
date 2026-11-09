// myrmidon(PROCS-1.2): the api child's side of the supervisor IPC contract —
// `ready` only under the role+IPC, and `drain` closes the server, the idle
// keep-alives, the live-events clients (1012), runs the app shutdown and
// exits after the grace with closeAllConnections as the backstop.
import { describe, expect, it, vi } from "vitest";
import type { Server as HttpServer } from "node:http";
import { reportReadyToSupervisor, wireSupervisorDrainHandler } from "./child.js";
import { SUPERVISOR_IPC_DRAIN, SUPERVISOR_IPC_READY } from "./supervisor.js";

function fakeServer() {
  const calls: string[] = [];
  const server = {
    close(cb?: () => void) {
      calls.push("close");
      cb?.();
    },
    closeIdleConnections() {
      calls.push("closeIdleConnections");
    },
    closeAllConnections() {
      calls.push("closeAllConnections");
    },
  } as unknown as HttpServer;
  return { server, calls };
}

describe("api child IPC (PROCS-1.2)", () => {
  it("reports ready only when the process is a forked api child", () => {
    // myrmidon(OPE-10011): the vitest forks pool runs this file in a forked
    // process, so `process.send` exists here; the old assertion passed only
    // because the unbound call threw. Pin both cases explicitly instead.
    const original = Object.getOwnPropertyDescriptor(process, "send");
    try {
      // Not a child: no channel, no send.
      Object.defineProperty(process, "send", { value: undefined, configurable: true, writable: true });
      expect(reportReadyToSupervisor()).toBe(false);

      // A forked child: Node's send reads `this.connected`, so the call must
      // keep `process` as the receiver.
      const sent: unknown[] = [];
      Object.defineProperty(process, "send", {
        value: function send(this: unknown, message: unknown) {
          if (this !== process) throw new TypeError("Cannot read properties of undefined (reading 'connected')");
          sent.push(message);
          return true;
        },
        configurable: true,
        writable: true,
      });
      expect(reportReadyToSupervisor()).toBe(true);
      expect(sent).toEqual([{ type: SUPERVISOR_IPC_READY, pid: process.pid }]);
    } finally {
      if (original) Object.defineProperty(process, "send", original);
      else delete (process as { send?: unknown }).send;
    }
  });

  it("drain closes the server, idles keep-alives, 1012s the ws clients and exits after the grace", async () => {
    const { server, calls } = fakeServer();
    const shutdown = vi.fn(async () => {});
    const exit = vi.fn();
    const timers: Array<{ fn: () => void; ms: number; timer: { unref?: () => void } }> = [];
    const wsClient = { close: vi.fn() };
    const messages: Array<(m: unknown) => void> = [];
    const onSpy = vi
      .spyOn(process, "on")
      .mockImplementation(((event: string, handler: (m: unknown) => void) => {
        if (event === "message") messages.push(handler);
        return process;
      }) as typeof process.on);
    wireSupervisorDrainHandler({
      server,
      wsClients: () => new Set([wsClient]),
      shutdownAppServices: shutdown,
      exit,
      setTimeout: ((fn: () => void, ms: number) => {
        const timer = {};
        timers.push({ fn, ms, timer });
        return timer as NodeJS.Timeout;
      }) as unknown as typeof setTimeout,
      log: { info: () => {}, warn: () => {} },
    });
    onSpy.mockRestore();
    expect(messages).toHaveLength(1);
    messages[0]({ type: SUPERVISOR_IPC_DRAIN, graceMs: 30_000 });
    expect(calls).toEqual(["close", "closeIdleConnections"]);
    expect(wsClient.close).toHaveBeenCalledWith(1012, "process drain");
    expect(shutdown).toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    // The grace timer is the only scheduled one — run it.
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(30_000);
    timers[0].fn();
    expect(calls).toEqual(["close", "closeIdleConnections", "closeAllConnections"]);
    // finalize() awaits the app shutdown — let the microtasks land.
    await Promise.resolve();
    await Promise.resolve();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("a second drain message does not re-run the drain", () => {
    const { server, calls } = fakeServer();
    const exit = vi.fn();
    const messages: Array<(m: unknown) => void> = [];
    const onSpy = vi
      .spyOn(process, "on")
      .mockImplementation(((event: string, handler: (m: unknown) => void) => {
        if (event === "message") messages.push(handler);
        return process;
      }) as typeof process.on);
    wireSupervisorDrainHandler({
      server,
      wsClients: () => new Set(),
      shutdownAppServices: async () => {},
      exit,
      setTimeout: (() => ({})) as unknown as typeof setTimeout,
      log: { info: () => {}, warn: () => {} },
    });
    onSpy.mockRestore();
    messages[0]({ type: SUPERVISOR_IPC_DRAIN, graceMs: 1 });
    messages[0]({ type: SUPERVISOR_IPC_DRAIN, graceMs: 1 });
    expect(calls).toEqual(["close", "closeIdleConnections"]);
  });
});
