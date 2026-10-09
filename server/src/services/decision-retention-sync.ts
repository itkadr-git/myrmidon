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
 * over here; the retention sweep in `server/src/index.ts` (`runRetentionSweep`
 * — the existing periodic pass that also runs auto-archive) drains the parked
 * snapshots, so the writes happen on the server's schedule rather than inside a
 * request.
 *
 * The guarantee it has to keep:
 *   - a read never waits for the sync and never fails because of it:
 *     `schedule()` only parks the newest snapshot for the company;
 *   - one pass per company at a time (mutex) and at most one pass per company
 *     per interval (debounce): a snapshot that arrives while a pass runs, or
 *     before the interval expired, stays parked for a later tick — a board
 *     polling once a second still writes at most once per interval instead of
 *     turning the feed back into a writer;
 *   - only the newest snapshot per company is kept, so the queue is bounded by
 *     the number of companies read, not by the poll rate;
 *   - a failed pass is logged and dropped: the next read keeps showing the
 *     state the previous pass stored, and the next snapshot retries.
 */

export const DECISION_RETENTION_SYNC_MIN_INTERVAL_MS = 30_000;

export type DecisionRetentionSyncSink = {
  schedule: (companyId: string, items: readonly AttentionItem[]) => void;
};

export type DecisionRetentionSyncScheduler = DecisionRetentionSyncSink & {
  /** Write every parked snapshot whose debounce window has elapsed. */
  drainDue: () => Promise<number>;
  /** Write every parked snapshot now, ignoring the debounce (tests, shutdown). */
  drain: () => Promise<number>;
  /** Write the parked snapshot of one company, ignoring the debounce (tests). */
  drainCompany: (companyId: string) => Promise<boolean>;
  /** Companies with a snapshot parked and not yet written. */
  pendingCompanies: () => number;
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

type ParkedSnapshot = {
  items: AttentionItem[];
  /** Earliest time this snapshot may be written. */
  dueAt: number;
};

export function createDecisionRetentionSyncScheduler(
  options: DecisionRetentionSyncSchedulerOptions,
): DecisionRetentionSyncScheduler {
  const minIntervalMs = Math.max(0, options.minIntervalMs ?? DECISION_RETENTION_SYNC_MIN_INTERVAL_MS);
  const now = options.now ?? (() => Date.now());
  const writeSnapshot =
    options.syncItems ??
    ((companyId: string, items: readonly AttentionItem[]) =>
      decisionRetentionService(options.db).syncItems(companyId, items));
  const onError =
    options.onError ??
    ((error: unknown, companyId: string) => {
      logger.error({ err: error, companyId }, "decision retention background sync failed");
    });

  const parked = new Map<string, ParkedSnapshot>();
  const running = new Set<string>();
  /** Last attempted pass per company; drives the debounce window. */
  const lastPassAt = new Map<string, number>();

  async function runCompany(companyId: string): Promise<boolean> {
    const snapshot = parked.get(companyId);
    if (snapshot === undefined || running.has(companyId)) return false;
    // Take the snapshot before awaiting: a read that arrives while the pass
    // runs parks a newer one, which a later tick (not this pass) decides about.
    parked.delete(companyId);
    running.add(companyId);
    lastPassAt.set(companyId, now());
    try {
      await writeSnapshot(companyId, snapshot.items);
      return true;
    } catch (error) {
      onError(error, companyId);
      return false;
    } finally {
      running.delete(companyId);
    }
  }

  async function runDue(force: boolean): Promise<number> {
    const at = now();
    const due: string[] = [];
    for (const [companyId, snapshot] of parked) {
      if (force || snapshot.dueAt <= at) due.push(companyId);
    }

    let written = 0;
    for (const companyId of due) {
      if (await runCompany(companyId)) written += 1;
    }
    return written;
  }

  return {
    schedule(companyId, items) {
      if (items.length === 0) return;
      const lastPass = lastPassAt.get(companyId);
      // Debounce per company: the first snapshot is due immediately, every
      // later one waits out the interval measured from the previous pass.
      parked.set(companyId, {
        items: [...items],
        dueAt: lastPass === undefined ? now() : lastPass + minIntervalMs,
      });
    },
    drainDue: () => runDue(false),
    drainCompany: (companyId) => runCompany(companyId),
    drain: () => runDue(true),
    pendingCompanies: () => parked.size,
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