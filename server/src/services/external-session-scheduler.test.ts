import { describe, expect, it, vi } from "vitest";
import { ExternalSessionScheduler } from "./external-session-scheduler.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = () => resolvePromise();
  });
  return { promise, resolve };
}

describe("ExternalSessionScheduler", () => {
  it("limits each credential independently and drains its queue in FIFO order", async () => {
    const scheduler = new ExternalSessionScheduler({ concurrencyPerCredential: 1 });
    const first = deferred();
    const second = deferred();
    const third = deferred();
    const started: string[] = [];
    const run = (name: string, gate: ReturnType<typeof deferred>) => async () => {
      started.push(name);
      await gate.promise;
      return name;
    };

    const firstResult = scheduler.schedule("account-a", run("first", first));
    const secondResult = scheduler.schedule("account-a", run("second", second));
    const independentResult = scheduler.schedule("account-b", async () => "independent");
    const thirdResult = scheduler.schedule("account-a", run("third", third));

    await vi.waitFor(() => expect(started).toEqual(["first"]));
    await expect(independentResult).resolves.toBe("independent");
    expect(scheduler.snapshot()).toEqual({
      activeByCredential: { "account-a": 1 },
      queuedByCredential: { "account-a": 2 },
    });

    first.resolve();
    await expect(firstResult).resolves.toBe("first");
    await vi.waitFor(() => expect(started).toEqual(["first", "second"]));
    second.resolve();
    await expect(secondResult).resolves.toBe("second");
    await vi.waitFor(() => expect(started).toEqual(["first", "second", "third"]));
    third.resolve();
    await expect(thirdResult).resolves.toBe("third");
    expect(scheduler.snapshot()).toEqual({ activeByCredential: {}, queuedByCredential: {} });
  });

  it("removes an aborted queued run without dispatching it", async () => {
    const scheduler = new ExternalSessionScheduler({ concurrencyPerCredential: 1 });
    const firstGate = deferred();
    const first = scheduler.schedule("account-a", () => firstGate.promise);
    const controller = new AbortController();
    const queuedRun = vi.fn(async () => "must-not-run");
    const queued = scheduler.schedule("account-a", queuedRun, {
      runId: "queued-run",
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(scheduler.snapshot().queuedByCredential["account-a"]).toBe(1));
    controller.abort(new Error("cancelled"));
    await expect(queued).rejects.toThrow("cancelled");
    expect(scheduler.cancel("queued-run")).toBe(false);
    expect(scheduler.snapshot()).toEqual({
      activeByCredential: { "account-a": 1 },
      queuedByCredential: {},
    });

    firstGate.resolve();
    await expect(first).resolves.toBeUndefined();
    expect(queuedRun).not.toHaveBeenCalled();
  });

  it("cancels queued work directly by run id", async () => {
    const scheduler = new ExternalSessionScheduler({ concurrencyPerCredential: 1 });
    const gate = deferred();
    const active = scheduler.schedule("account-a", () => gate.promise);
    const queued = scheduler.schedule("account-a", async () => "no", { runId: "cancel-me" });

    await vi.waitFor(() => expect(scheduler.cancel("cancel-me")).toBe(true));
    await expect(queued).rejects.toThrow("Run cancelled");
    gate.resolve();
    await expect(active).resolves.toBeUndefined();
  });

  it("shares one production scheduler across heartbeat service instances", async () => {
    const { heartbeatService, externalSessionScheduler } = await import("./heartbeat.js");
    const firstService = heartbeatService({} as never);
    const secondService = heartbeatService({} as never);
    const one = deferred();
    const anotherAccount = deferred();
    const first = externalSessionScheduler.schedule("company:account", () => one.promise);
    const second = externalSessionScheduler.schedule("company:account", async () => "blocked");
    const independent = externalSessionScheduler.schedule("company:other", () => anotherAccount.promise);

    await vi.waitFor(() => expect(externalSessionScheduler.snapshot().queuedByCredential["company:account"]).toBe(1));
    expect(firstService).toBeDefined();
    expect(secondService).toBeDefined();
    expect(externalSessionScheduler.snapshot().activeByCredential["company:other"]).toBe(1);
    one.resolve();
    anotherAccount.resolve();
    await Promise.all([first, second, independent]);
  });

  it("continues draining after a session rejects", async () => {
    const scheduler = new ExternalSessionScheduler({ concurrencyPerCredential: 1 });
    const next = vi.fn(async () => "ok");
    const failed = scheduler.schedule("account-a", async () => { throw new Error("failed"); });
    const succeeding = scheduler.schedule("account-a", next);

    await expect(failed).rejects.toThrow("failed");
    await expect(succeeding).resolves.toBe("ok");
    expect(next).toHaveBeenCalledOnce();
  });

  it("rejects invalid limits and missing credential identifiers", async () => {
    expect(() => new ExternalSessionScheduler({ concurrencyPerCredential: 0 })).toThrow();
    const scheduler = new ExternalSessionScheduler({ concurrencyPerCredential: 1 });
    await expect(scheduler.schedule(" ", async () => undefined)).rejects.toThrow("credentialId is required");
  });

  it("authorizes an opaque credential reference before starting work", async () => {
    const authorizeCredential = vi.fn((credentialId: string) => credentialId === "company-credential-1");
    const run = vi.fn(async () => "started");
    const scheduler = new ExternalSessionScheduler({ concurrencyPerCredential: 1, authorizeCredential });

    await expect(scheduler.schedule("other-company-credential", run)).rejects.toThrow("credentialId is not authorized");
    expect(run).not.toHaveBeenCalled();
    await expect(scheduler.schedule("company-credential-1", run)).resolves.toBe("started");
    expect(authorizeCredential).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledOnce();
  });

  it("rejects authorization failures without queueing or starting work", async () => {
    const run = vi.fn(async () => "started");
    const scheduler = new ExternalSessionScheduler({
      concurrencyPerCredential: 1,
      authorizeCredential: async () => { throw new Error("registry unavailable"); },
    });

    await expect(scheduler.schedule("company-credential-1", run)).rejects.toThrow("registry unavailable");
    expect(run).not.toHaveBeenCalled();
    expect(scheduler.snapshot()).toEqual({ activeByCredential: {}, queuedByCredential: {} });
  });
});
