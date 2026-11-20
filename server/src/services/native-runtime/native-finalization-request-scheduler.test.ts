import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@myrmidon/db";
import { startNativeFinalizationRequestScheduler } from "./native-finalization-request-scheduler.js";

afterEach(() => vi.useRealTimers());

describe("native finalization recovery scheduler", () => {
  it("retries failed work on a later tick and stops scheduling on shutdown", async () => {
    vi.useFakeTimers();
    const processRequest = vi.fn().mockRejectedValueOnce(new Error("workspace not ready")).mockResolvedValue(null);
    const onError = vi.fn();
    const scheduler = startNativeFinalizationRequestScheduler({ db: {} as Db, processRequest, onError, intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);
    expect(processRequest).toHaveBeenCalledTimes(2);
    await scheduler.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(processRequest).toHaveBeenCalledTimes(2);
  });

  it("does not overlap a running pass and awaits it during shutdown", async () => {
    vi.useFakeTimers();
    let finish!: (value: null) => void;
    const processRequest = vi.fn(() => new Promise<null>((resolve) => { finish = resolve; }));
    const scheduler = startNativeFinalizationRequestScheduler({ db: {} as Db, processRequest, onError: vi.fn(), intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(300);
    expect(processRequest).toHaveBeenCalledTimes(1);
    const stopped = scheduler.stop();
    finish(null);
    await stopped;
    await vi.advanceTimersByTimeAsync(100);
    expect(processRequest).toHaveBeenCalledTimes(1);
  });
});
