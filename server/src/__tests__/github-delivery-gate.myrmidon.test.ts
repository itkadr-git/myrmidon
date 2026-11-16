// myrmidon(WEBHOOK-LOCK-POOL): the in-process queue of a pull request and the
// limit of open delivery transactions.

import { describe, expect, it } from "vitest";
import { createKeyedQueue, createSemaphore, GITHUB_DELIVERY_MAX_CONCURRENT_TRANSACTIONS } from "../services/github-delivery-gate.js";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("keyed queue", () => {
  it("runs the jobs of one key one at a time, in the order they were queued", async () => {
    const queue = createKeyedQueue();
    const order: number[] = [];
    let running = 0;
    let maxRunning = 0;
    await Promise.all(Array.from({ length: 30 }, (_, index) => queue.run("pr-1", async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await pause(index % 3);
      order.push(index);
      running -= 1;
    })));
    expect(maxRunning).toBe(1);
    expect(order).toEqual(Array.from({ length: 30 }, (_, index) => index));
    expect(queue.size()).toBe(0);
  });

  it("does not make another key wait, and goes on after a failed job", async () => {
    const queue = createKeyedQueue();
    let release!: () => void;
    const blocked = queue.run("a", () => new Promise<void>((resolve) => { release = resolve; }));
    await expect(queue.run("b", async () => "done")).resolves.toBe("done");
    const failing = queue.run("a", async () => { throw new Error("boom"); });
    const after = queue.run("a", async () => "after");
    release();
    await blocked;
    await expect(failing).rejects.toThrow("boom");
    await expect(after).resolves.toBe("after");
    await pause(0);
    expect(queue.size()).toBe(0);
  });
});

describe("semaphore", () => {
  it("never runs more jobs than its limit and runs all of them", async () => {
    const gate = createSemaphore(GITHUB_DELIVERY_MAX_CONCURRENT_TRANSACTIONS);
    let done = 0;
    await Promise.all(Array.from({ length: 30 }, () => gate.run(async () => {
      expect(gate.active()).toBeLessThanOrEqual(GITHUB_DELIVERY_MAX_CONCURRENT_TRANSACTIONS);
      await pause(2);
      done += 1;
    })));
    expect(done).toBe(30);
    expect(gate.peak()).toBe(GITHUB_DELIVERY_MAX_CONCURRENT_TRANSACTIONS);
    expect(gate.active()).toBe(0);
  });

  it("frees the slot when a job fails", async () => {
    const gate = createSemaphore(1);
    await expect(gate.run(async () => { throw new Error("x"); })).rejects.toThrow("x");
    await expect(gate.run(async () => "ok")).resolves.toBe("ok");
    expect(gate.active()).toBe(0);
  });
});
