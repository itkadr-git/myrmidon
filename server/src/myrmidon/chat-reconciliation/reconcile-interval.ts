import { createCoalescedAsyncTrigger } from "../../services/chat-publication-reconciliation.js";
import { laneInterval } from "../monitoring/board-load/lanes.js";

/**
 * Gets the fallback interval for chat reconciliation in milliseconds.
 * This setting controls the maximum time between reconciliation passes when no events occur.
 * Default is 30 seconds if not set.
 * 
 * Separate from MYRMIDON_CHAT_RECONCILE_INTERVAL_MS, which only spaces the run milestone lane.
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
  let activeRuns = 0;
  const eventTrigger = createCoalescedAsyncTrigger({
    run: async () => {
      activeRuns += 1;
      try {
        await input.reconcile();
      } finally {
        activeRuns -= 1;
      }
    },
    onError: input.onError,
    minimumSpacingMs: 100, // Minimum spacing to prevent excessive runs
  });

  // Start fallback timer that triggers reconciliation periodically when idle
  const startFallbackTimer = () => {
    if (stopped || fallbackTimer) return;
    
    fallbackTimer = laneInterval("chat_reconcile", fallbackIntervalMs, () => {
      // Only run fallback reconciliation if no recent event-driven activity
      return eventTrigger.poll();
    });
    
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

    /** Number of reconciliation passes currently running (0 or 1). */
    getActiveTasksCount: () => activeRuns,
  };
}

// myrmidon(D1): MYRMIDON_CHAT_RECONCILE_INTERVAL_MS setting. See
// docs/myrmidon/SETTINGS.md.

/**
 * Minimum spacing (ms) between runs of the run milestone sweep
 * (enqueueChatRunMilestones), the one chat reconciliation lane this setting
 * throttles: server/src/app.ts passes it only to that lane's coalesced
 * trigger (milestoneMinimumSpacingMs). The publication lane, which also runs
 * the inbound-wakeup notice sweep, keeps its usual pace. The value replaces
 * the trigger's default spacing (100 ms in createCoalescedAsyncTrigger)
 * rather than adding to it. The lane already coalesces concurrent wakeups
 * and skips a tick while a previous pass is still running, so this only
 * matters once a pass is cheap enough to otherwise run back-to-back with
 * nothing to do.
 *
 * Unset (or <= 0, or unparseable) leaves today's spacing untouched: the D1
 * query rewrites (uuid-typed owner join, deduplicated EXISTS checks, indexed
 * and hoisted inbound-link lookup) are the default-on fix for the "scans
 * full history every poll" defect. This setting is an opt-in throttle for a
 * deployment that additionally wants the milestone lane to poll less often
 * while chats are idle — a deployment-specific value, not a new default
 * cadence.
 */
export function chatReconcileMinimumSpacingMs(
  env: { MYRMIDON_CHAT_RECONCILE_INTERVAL_MS?: string } = process.env,
): number | undefined {
  const raw = env.MYRMIDON_CHAT_RECONCILE_INTERVAL_MS;
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
