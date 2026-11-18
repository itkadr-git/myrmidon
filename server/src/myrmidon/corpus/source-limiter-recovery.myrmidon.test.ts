import { describe, expect, it, vi } from "vitest";
import { createDownloadLimiter } from "./source-fetch.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe("download limiter recovery", () => {
  it("passes one slot in FIFO order after success and rejection", async () => {
    const limiter = createDownloadLimiter(1, 2);
    const gates = { A: deferred<string>(), B: deferred<string>(), C: deferred<string>() };
    const started = { B: deferred<void>(), C: deferred<void>() };
    const order: string[] = [];
    let active = 0;
    let peak = 0;
    const run = (name: keyof typeof gates) => limiter.run(async () => {
      order.push(name);
      active += 1;
      peak = Math.max(peak, active);
      if (name !== "A") started[name].resolve();
      try {
        return await gates[name].promise;
      } finally {
        active -= 1;
      }
    });
    const a = run("A");
    const b = run("B");
    const failure = new Error("download B failed");
    const bRejected = expect(b).rejects.toBe(failure);
    const c = run("C");
    const refused = vi.fn(async () => "D");
    await expect(limiter.run(refused)).rejects.toMatchObject({ status: 503, code: "source_fetch_busy" });
    expect(refused).not.toHaveBeenCalled();
    expect(order).toEqual(["A"]);

    gates.A.resolve("result A");
    await expect(a).resolves.toBe("result A");
    await started.B.promise;
    expect(order).toEqual(["A", "B"]);
    gates.B.reject(failure);
    await bRejected;
    await started.C.promise;
    expect(order).toEqual(["A", "B", "C"]);
    gates.C.resolve("result C");
    await expect(c).resolves.toBe("result C");
    await expect(limiter.run(async () => {
      order.push("E");
      active += 1;
      peak = Math.max(peak, active);
      active -= 1;
      return "result E";
    })).resolves.toBe("result E");
    expect(order).toEqual(["A", "B", "C", "E"]);
    expect(active).toBe(0);
    expect(peak).toBe(1);
    expect(refused).not.toHaveBeenCalled();
  });

  it("releases the slot when a callback throws synchronously", async () => {
    const limiter = createDownloadLimiter(1, 2);
    const failure = new Error("synchronous failure");
    const failed = limiter.run((): Promise<string> => { throw failure; });
    await expect(failed).rejects.toBe(failure);
    const next = vi.fn(async () => "recovered");
    await expect(limiter.run(next)).resolves.toBe("recovered");
    expect(next).toHaveBeenCalledOnce();
  });
});
