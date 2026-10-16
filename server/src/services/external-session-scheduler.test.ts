import { describe, expect, it, vi } from "vitest";
import { ExternalSessionScheduler } from "./external-session-scheduler.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
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
});
