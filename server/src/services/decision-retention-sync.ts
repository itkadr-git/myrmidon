import type { Db } from "@paperclipai/db";
import type { AttentionItem } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { decisionRetentionService } from "./decision-retention.js";

/**
 * myrmidon(1.6.5-F-15-C): the only writer of the decision-retention rows that
 * back the attention feed.
 *
 * `enrichAttentionItems` used to call `decisionRetentionService.syncItems` on
 * every GET, so rendering the feed inserted and updated `decision_retention`
 * rows inside the read path (and the feed's own latency included those writes).
 * The read path now projects the stored state read-only and hands the snapshot
 * here; this scheduler performs the writes afterwards, on its own timer.
 *
 * The guarantee it has to keep:
 *   - a read never waits for the sync and never fails because of it:
 *     `schedule()` only parks the newest snapshot for the company and arms one
 *     unref'd timer;
 *   - one pass per company at a time (mutex) and at most one pass per company
 *     per interval (debounce). A snapshot arriving while a pass runs is kept
 *     and runs after the next interval, so a board polling once a second still
 *     writes at most once per interval instead of turning the feed back into a
 *     writer;
 *   - a failed pass is logged and dropped: the next read keeps showing the
 *     state the previous pass stored, and the next snapshot retries.
 */

export const DECISION_RETENTION_SYNC_MIN_INTERVAL_MS = 30_000;
/**
 * Timer cadence. A parked snapshot whose company is past its debounce window
 * is written on the next tick, so the first snapshot after a cold start costs
 * at most this much freshness while the per-company interval still caps the
 * write rate.
 */
const TICK_MS = 5_000;
/** Timer cadence floor, so a switched-off debounce (tests) still ticks. */
const TIMER_FLOOR_MS = 1_000;

export type DecisionRetentionSyncSink = {
  schedule: (companyId: string, items: readonly AttentionItem[]) => void;
};

export type DecisionRetentionSyncScheduler = DecisionRetentionSyncSink & {
  /** Run every parked snapshot now, ignoring the debounce (tests, shutdown). */
  drain: () => Promise<void>;
  /** Companies with a snapshot parked and not yet written. */
  pendingCompanies: () => number;
  /** Disarm the timer; parked snapshots stay parked until the next schedule. */
  stop: () => void;
};

export type DecisionRetentionSyncSchedulerOptions = {
  db: Db;
  /** Debounce window per company; 0 makes the next snapshot due at once. */
  minIntervalMs?: number;
  /** Clock override; tests pin the debounce window instead of sleeping. */
  now?: () => number;
  /** Write callback; defaults to `decisionRetentionService(db).syncItems`. */
  syncItems?: (companyId: string, items: readonly AttentionItem[]) => Promise<unknown>;
  /** Failure hook; defaults to one error log per failed company pass. */
  onError?: (error: unknown, companyId: string) => void;
};

export function createDecisionRetentionSyncScheduler(
  options: DecisionRetentionSyncSchedulerOptions,
): DecisionRetentionSyncScheduler {
  const minIntervalMs = Math.max(0, options.minIntervalMs ?? DECISION_RETENTION_SYNC_MIN_INTERVAL_MS);
  const now = options.now ?? (() => Date.now());
  const writeSnapshot = options.syncItems
    ?? ((companyId: string, items: readonly AttentionItem[]) =>
      decisionRetentionService(options.db).syncItems(companyId, items));
  const onError = options.onError ?? ((error: unknown, companyId: string) => {
    logger.error({ err: error, companyId }, "decision retention background sync failed");
  });

  const pending = new Map<string, { items: AttentionItem[]; dueAt: number }>();
  const running = new Set<string>();
  const lastRunAt = new Map<string, number>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  function clearTimer() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  function timerIntervalMs() {
    const cadence = minIntervalMs > 0 ? Math.min(minIntervalMs, TICK_MS) : TICK_MS;
    return Math.max(TIMER_FLOOR_MS, cadence);
  }

  function ensureTimer() {
    if (stopped || timer || pending.size === 0) return;
    timer = setInterval(() => {
      void runDue(false);
    }, timerIntervalMs());
    timer.unref?.();
  }

  async function runCompany(companyId: string) {
    const entry = pending.get(companyId);
    if (!entry || running.has(companyId)) return;
    // Take the snapshot off the queue before awaiting, so a read arriving
    // during the pass parks a fresh one instead of racing this write.
    pending.delete(companyId);
    running.add(companyId);
    lastRunAt.set(companyId, now());
    try {
      await writeSnapshot(companyId, entry.items);
    } catch (error) {
      onError(error, companyId);
    } finally {
      running.delete(companyId);
    }
  }

  async function runDue(force: boolean) {
    const at = now();
    const due: string[] = [];
    for (const [companyId, entry] of pending) {
      if (force || entry.dueAt <= at) due.push(companyId);
    }
    for (const companyId of due) await runCompany(companyId);
    if (pending.size === 0) clearTimer();
  }

  return {
    schedule(companyId, items) {
      if (stopped || items.length === 0) return;
      const lastRun = lastRunAt.get(companyId);
      // Debounce per company: the first snapshot is due immediately, every
      // later one waits out the interval measured from the previous pass.
      const dueAt = lastRun === undefined ? now() : lastRun + minIntervalMs;
      pending.set(companyId, { items: [...items], dueAt });
      ensureTimer();
    },
    drain: () => runDue(true),
    pendingCompanies: () => pending.size,
    stop() {
      stopped = true;
      clearTimer();
    },
  };
}

const schedulersByDb = new WeakMap<Db, DecisionRetentionSyncScheduler>();

/**
 * The shared scheduler for one Db handle: every attention read in a process
 * parks its snapshot in the same per-company queue, so two concurrent readers
 * of the same company cannot double-write. Keyed by Db exactly like the feed
 * cache (`attentionFeedCaches`), which keeps test handles isolated.
 */
export function decisionRetentionSyncScheduler(
  db: Db,
  options: Omit<DecisionRetentionSyncSchedulerOptions, "db"> = {},
): DecisionRetentionSyncScheduler {
  const existing = schedulersByDb.get(db);
  if (existing) return existing;
  const created = createDecisionRetentionSyncScheduler({ db, ...options });
  schedulersByDb.set(db, created);
  return created;
}