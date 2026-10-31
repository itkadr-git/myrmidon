import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  ExternalSessionScheduler,
  externalSessionCredentialKey,
  externalSessionScheduler,
  scheduleExternalSessionRun,
} from "./external-session-scheduler.js";

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

  it("shares one process-wide scheduler: heartbeat.ts never constructs its own", () => {
    const source = readFileSync(new URL("./heartbeat.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/new\s+ExternalSessionScheduler\s*\(/);
    expect(source).toContain("scheduleExternalSessionRun(");
    // Stop reaches a run queued behind the limit only through the shared scheduler.
    expect(source).toContain("externalSessionScheduler.cancel(run.id");
  });

  it("limits sessions across callers through the shared scheduler", async () => {
    const scope = { companyId: "company-shared", connectionId: "account-shared" };
    const firstGate = deferred();
    const started: string[] = [];
    // Two independent "service instances" hit the same exported scheduler.
    const first = scheduleExternalSessionRun(scope, async () => {
      started.push("first");
      await firstGate.promise;
    });
    const second = scheduleExternalSessionRun(scope, async () => {
      started.push("second");
    });
    const other = scheduleExternalSessionRun({ companyId: "company-shared", connectionId: "other-account" }, async () => {
      started.push("other");
    });

    await vi.waitFor(() => expect(externalSessionScheduler.snapshot().queuedByCredential[externalSessionCredentialKey(scope)]).toBe(1));
    await other;
    expect(started).toEqual(["first", "other"]);
    firstGate.resolve();
    await Promise.all([first, second]);
    expect(started).toEqual(["first", "other", "second"]);
  });

  it("keys the limit by company and connection, not by grant", async () => {
    const base = { companyId: "company-1", connectionId: "account-1" };
    expect(externalSessionCredentialKey({ ...base })).toBe("company-1:account-1");
    // Another company with the same connection id is a different credential.
    expect(externalSessionCredentialKey({ ...base, companyId: "company-2" })).not.toBe(externalSessionCredentialKey(base));

    const scheduler = new ExternalSessionScheduler({ concurrencyPerCredential: 1 });
    const gate = deferred();
    const started: string[] = [];
    // The grant is not part of the scope: two grants of one account share the limit.
    const grantA = scheduleExternalSessionRun(base, async () => { started.push("grant-a"); await gate.promise; }, {}, scheduler);
    const grantB = scheduleExternalSessionRun(base, async () => { started.push("grant-b"); }, {}, scheduler);
    await vi.waitFor(() => expect(scheduler.snapshot().queuedByCredential["company-1:account-1"]).toBe(1));
    expect(started).toEqual(["grant-a"]);
    gate.resolve();
    await Promise.all([grantA, grantB]);
    expect(started).toEqual(["grant-a", "grant-b"]);
  });

  it("wires queued-run cancellation by run id and by signal through the helper", async () => {
    const scheduler = new ExternalSessionScheduler({ concurrencyPerCredential: 1 });
    const scope = { companyId: "company-1", connectionId: "account-1" };
    const gate = deferred();
    const active = scheduleExternalSessionRun(scope, () => gate.promise, {}, scheduler);
    const byId = scheduleExternalSessionRun(scope, async () => "no", { runId: "run-by-id" }, scheduler);
    const controller = new AbortController();
    const bySignal = scheduleExternalSessionRun(scope, async () => "no", { runId: "run-by-signal", signal: controller.signal }, scheduler);
    await vi.waitFor(() => expect(scheduler.snapshot().queuedByCredential["company-1:account-1"]).toBe(2));

    expect(scheduler.cancel("run-by-id", new Error("stopped"))).toBe(true);
    await expect(byId).rejects.toThrow("stopped");
    controller.abort(new Error("aborted"));
    await expect(bySignal).rejects.toThrow("aborted");
    expect(scheduler.snapshot().queuedByCredential).toEqual({});
    gate.resolve();
    await active;
  });

  it("does not cancel a run that already holds the slot", async () => {
    const scheduler = new ExternalSessionScheduler({ concurrencyPerCredential: 1 });
    const gate = deferred();
    const running = scheduler.schedule("account-a", async () => { await gate.promise; return "done"; }, { runId: "running" });
    await vi.waitFor(() => expect(scheduler.snapshot().activeByCredential["account-a"]).toBe(1));
    expect(scheduler.cancel("running")).toBe(false);
    gate.resolve();
    await expect(running).resolves.toBe("done");
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
