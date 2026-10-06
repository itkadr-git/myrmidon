import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createReconcileInterval } from "./reconcile-interval.js";

describe("createReconcileInterval", () => {
  beforeEach(() => {
    // Mock setTimeout and setInterval to have synchronous control
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  it("should trigger reconciliation immediately when notify is called", async () => {
    const reconcileFn = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    
    const interval = createReconcileInterval({
      reconcile: reconcileFn,
      onError,
      fallbackIntervalMs: 1000, // 1 second fallback
    });

    // Initially, reconciliation should not have been called
    expect(reconcileFn).toHaveBeenCalledTimes(0);

    // Call notify to trigger event-driven reconciliation
    interval.notify();

    // Fast-forward time to allow the trigger to execute
    await vi.advanceTimersByTimeAsync(10);

    // Reconciliation should have been called
    expect(reconcileFn).toHaveBeenCalledTimes(1);
    
    interval.stop();
  });

  it("should call fallback reconciliation after interval when no events occur", async () => {
    const reconcileFn = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    
    const interval = createReconcileInterval({
      reconcile: reconcileFn,
      onError,
      fallbackIntervalMs: 100, // 100ms fallback
    });

    // Initially, reconciliation should not have been called
    expect(reconcileFn).toHaveBeenCalledTimes(0);

    // Fast-forward time by 100ms to trigger fallback
    await vi.advanceTimersByTimeAsync(100);

    // Fallback reconciliation should have been called
    expect(reconcileFn).toHaveBeenCalledTimes(1);
    
    interval.stop();
  });

  it("should reset fallback timer when notified", async () => {
    const reconcileFn = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    
    const interval = createReconcileInterval({
      reconcile: reconcileFn,
      onError,
      fallbackIntervalMs: 200, // 200ms fallback
    });

    // Advance time halfway to fallback
    await vi.advanceTimersByTimeAsync(100);

    // Should not have called reconciliation yet
    expect(reconcileFn).toHaveBeenCalledTimes(0);

    // Notify - this should reset the fallback timer
    interval.notify();
    await vi.advanceTimersByTimeAsync(10);

    // Should have called reconciliation due to notification
    expect(reconcileFn).toHaveBeenCalledTimes(1);

    // Advance time to where the original fallback would have occurred
    await vi.advanceTimersByTimeAsync(100);

    // Should not have called reconciliation again (original timer was cancelled)
    expect(reconcileFn).toHaveBeenCalledTimes(1);

    // Advance time to reach the new fallback period
    await vi.advanceTimersByTimeAsync(200);

    // Should have called reconciliation again from fallback
    expect(reconcileFn).toHaveBeenCalledTimes(2);
    
    interval.stop();
  });

  it("should stop properly and clear timers", async () => {
    const reconcileFn = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    
    const interval = createReconcileInterval({
      reconcile: reconcileFn,
      onError,
      fallbackIntervalMs: 100,
    });

    // Verify timer is active by checking that advancing time triggers reconciliation
    expect(reconcileFn).toHaveBeenCalledTimes(0);
    
    interval.stop();
    
    // Advance time after stopping
    await vi.advanceTimersByTimeAsync(200);
    
    // Should not have called reconciliation after stop
    expect(reconcileFn).toHaveBeenCalledTimes(0);
  });

  it("should handle errors properly", async () => {
    const error = new Error("Test error");
    const reconcileFn = vi.fn().mockRejectedValue(error);
    const onError = vi.fn();
    
    const interval = createReconcileInterval({
      reconcile: reconcileFn,
      onError,
      fallbackIntervalMs: 100,
    });

    // Trigger reconciliation which will fail
    interval.notify();
    await vi.advanceTimersByTimeAsync(10);

    // Error handler should have been called
    expect(onError).toHaveBeenCalledWith(error);
    
    interval.stop();
  });

  it("should return correct active tasks count", () => {
    const reconcileFn = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    
    const interval = createReconcileInterval({
      reconcile: reconcileFn,
      onError,
      fallbackIntervalMs: 100,
    });

    // Initially should show 0 active tasks (no ongoing work)
    expect(interval.getActiveTasksCount()).toBe(0);
    
    interval.stop();
  });
});