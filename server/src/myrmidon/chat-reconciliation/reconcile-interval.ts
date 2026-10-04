import { createCoalescedAsyncTrigger } from "../../../services/chat-publication-reconciliation.js";

/**
 * Gets the fallback interval for chat reconciliation in milliseconds.
 * This setting controls the maximum time between reconciliation passes when no events occur.
 * Default is 30 seconds if not set.
 * 
 * This replaces the old MYRMIDON_CHAT_RECONCILE_INTERVAL_MS which was used for a different purpose.
 */
export function getChatReconcileFallbackIntervalMs(
  env: { MYRMIDON_CHAT_RECONCILE_FALLBACK_INTERVAL_MS?: string } = process.env,
): number {
  const raw = env.MYRMIDON_CHAT_RECONCILE_FALLBACK_INTERVAL_MS;
  if (!raw) return 30_000; // Default 30 seconds
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000;
}

/**
 * Chat reconciliation interval management with fallback timer.
 * Implements event-driven reconciliation with configurable fallback interval.
 */
export function createReconcileInterval(input: {
  reconcile: () => Promise<unknown>;
  onError: (error: unknown) => void;
  fallbackIntervalMs?: number;
}) {
  const fallbackIntervalMs = input.fallbackIntervalMs ?? 30_000; // Default 30 seconds
  
  let fallbackTimer: NodeJS.Timeout | null = null;
  let stopped = false;

  // Create coalesced trigger for event-driven reconciliation
  const eventTrigger = createCoalescedAsyncTrigger({
    run: input.reconcile,
    onError: input.onError,
    minimumSpacingMs: 100, // Minimum spacing to prevent excessive runs
  });

  // Start fallback timer that triggers reconciliation periodically when idle
  const startFallbackTimer = () => {
    if (stopped || fallbackTimer) return;
    
    fallbackTimer = setInterval(() => {
      // Only run fallback reconciliation if no recent event-driven activity
      eventTrigger.poll();
    }, fallbackIntervalMs);
    
    // Unref the timer so it doesn't keep the process alive
    if (fallbackTimer && typeof (fallbackTimer as any).unref === 'function') {
      (fallbackTimer as any).unref();
    }
  };

  // Initial start of fallback timer
  startFallbackTimer();

  return {
    /**
     * Trigger reconciliation due to an event (like new publication/action/milestone).
     * This will cancel the immediate fallback timer and reset the interval.
     */
    notify: () => {
      if (stopped) return;
      
      // Notify the coalesced trigger which will handle the actual reconciliation
      eventTrigger.notify();
      
      // Clear and restart the fallback timer to reset the interval
      if (fallbackTimer) {
        clearInterval(fallbackTimer);
        fallbackTimer = null;
      }
      startFallbackTimer();
    },
    
    /**
     * Stop all reconciliation activities and timers.
     */
    stop: () => {
      stopped = true;
      
      if (fallbackTimer) {
        clearInterval(fallbackTimer);
        fallbackTimer = null;
      }
      
      eventTrigger.stop();
    },
    
    /**
     * Wait for any ongoing reconciliation to complete.
     */
    async drain() {
      await eventTrigger.drain();
    },
    
    /**
     * Get current active tasks count for monitoring purposes.
     */
    getActiveTasksCount: () => {
      // This is a simplified counter - we'll return 1 if there's any active work, 0 otherwise
      return eventTrigger['running'] ? 1 : 0;
    }
  };
}
