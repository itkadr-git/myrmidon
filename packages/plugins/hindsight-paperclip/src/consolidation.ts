import type {
  BankMentalModelsPage,
  HindsightClient,
} from "./client.js";

/**
 * Nightly, additive consolidation pass over an existing Hindsight bank.
 *
 * The pass never rewrites or deletes source records. It walks the bank's
 * stored documents in bounded pages (so each HTTP call stays small), asks
 * Hindsight to consolidate the extracted memories once per walk (the server
 * deduplicates pending consolidation operations, so repeats are safe), and
 * refreshes only the mental models the server itself flags as stale
 * (`is_stale`) — that flag is what makes a second pass a no-op instead of a
 * duplicate refresh.
 *
 * The pass is bounded and resumable: the caller hands in a time budget and a
 * checkpoint (the document-list offset reached last time). When the budget
 * runs out mid-walk the function returns with the checkpoint of where it
 * stopped plus exact counters, so the caller can pass the same checkpoint
 * back and continue later.
 *
 * There is no scheduler here and no external control plane: the caller (the
 * board's nightly consolidation task, not this package) owns the schedule,
 * the budget and the checkpoint storage.
 */

/** Tunables of one consolidation pass. All bounds are caller-supplied. */
export interface ConsolidationPassOptions {
  /** Bank to consolidate. Required. */
  bankId: string;
  /** Wall-clock budget in ms for the whole pass. Required, must be > 0. */
  timeBudgetMs: number;
  /**
   * Documents already processed by previous passes — the walk resumes from
   * this list offset. Defaults to 0 (a fresh pass over the whole bank).
   */
  checkpoint?: ConsolidationCheckpoint | null;
  /** Documents per list page. Bounded, default 50. */
  pageSize?: number;
  /** Mental models scanned per list page. Bounded, default 50. */
  modelPageSize?: number;
  /** Hard cap on models refreshed in one pass, default 20. */
  maxModelRefreshes?: number;
  /** Monotonic clock (ms). Injectable for tests; defaults to Date.now. */
  now?: () => number;
}

/** Resumable position of a pass, persisted by the caller between runs. */
export interface ConsolidationCheckpoint {
  /** Offset into the bank's document list reached by the last pass. */
  documentOffset: number;
  /** Total documents the list reported when the last pass stopped. */
  documentTotal: number | null;
}

/** What one pass did, with exact counts for the caller's report. */
export interface ConsolidationPassResult {
  /** True when the walk reached the end of the document list. */
  completed: boolean;
  /** Checkpoint to store; pass it back to continue where this pass stopped. */
  checkpoint: ConsolidationCheckpoint;
  /** Source records visited by this pass (not created, never modified). */
  documentsProcessed: number;
  /** Consolidation triggers; server-side dedup makes repeats idempotent. */
  consolidationsTriggered: number;
  /** True when the single consolidate call was deduplicated by the server. */
  consolidationDeduplicated: boolean;
  /** Mental models this pass asked Hindsight to refresh. */
  modelsRefreshed: number;
  /** Models skipped because the server did not flag them stale. */
  modelsSkippedFresh: number;
  /** When the pass ended (ms, caller's clock). */
  finishedAtMs: number;
}

interface Clock {
  (): number;
}

/**
 * Run one bounded, additive consolidation pass over the bank.
 *
 * Ordering: pages are walked first (so the checkpoint advances only over
 * records actually visited), then one consolidation is triggered, then stale
 * mental models are refreshed while budget and the refresh cap allow.
 * Triggering consolidation after the walk lets the newly paged records join
 * the same consolidation as the rest of the bank.
 */
export async function runConsolidationPass(
  client: HindsightClient,
  options: ConsolidationPassOptions,
): Promise<ConsolidationPassResult> {
  if (!options.bankId || typeof options.bankId !== "string") {
    throw new Error("bankId is required");
  }
  if (typeof options.timeBudgetMs !== "number" || !Number.isFinite(options.timeBudgetMs) || options.timeBudgetMs <= 0) {
    throw new Error("timeBudgetMs must be a positive number");
  }
  const clock: Clock = options.now ?? Date.now;
  // One clock read per decision, kept in nowMs: the value a check observed
  // is the value the result reports, so finishedAtMs is the exact moment
  // the budget ran out rather than a later re-read of the clock.
  let nowMs = clock();
  const startedAt = nowMs;
  const deadline = startedAt + options.timeBudgetMs;
  const pageSize = normalizePageSize(options.pageSize, 50);
  const modelPageSize = normalizePageSize(options.modelPageSize, 50);
  const maxModelRefreshes = normalizeCap(options.maxModelRefreshes, 20);
  const checkpoint: ConsolidationCheckpoint = {
    documentOffset: Math.max(0, Math.floor(options.checkpoint?.documentOffset ?? 0)),
    documentTotal: typeof options.checkpoint?.documentTotal === "number" ? options.checkpoint.documentTotal : null,
  };

  const result: ConsolidationPassResult = {
    completed: false,
    checkpoint,
    documentsProcessed: 0,
    consolidationsTriggered: 0,
    consolidationDeduplicated: false,
    modelsRefreshed: 0,
    modelsSkippedFresh: 0,
    finishedAtMs: 0,
  };

  let walkOffset = checkpoint.documentOffset;

  // Phase 1 — the bounded document walk. Every page is a bounded list call;
  // records are only read, so repeats can lose nothing and create nothing.
  while ((nowMs = clock()) < deadline) {
    const page = await client.listDocuments(options.bankId, pageSize, walkOffset);
    const reachedEnd = walkOffset + page.items.length >= page.total;
    walkOffset += page.items.length;
    result.documentsProcessed += page.items.length;
    checkpoint.documentOffset = walkOffset;
    checkpoint.documentTotal = page.total;
    if (reachedEnd) {
      result.completed = true;
      break;
    }
    // An empty page with items left is a stalled list; stop instead of
    // spinning to the budget with no progress.
    if (page.items.length === 0) break;
  }

  // The loop condition (or the break above) already observed the clock;
  // after a break the time has not been re-checked since the last page,
  // so one observation covers both paths without extra reads.
  if (nowMs >= deadline || (nowMs = clock()) >= deadline) {
    result.finishedAtMs = nowMs;
    return result;
  }

  // Phase 2 — one consolidation trigger for the whole bank. Hindsight
  // deduplicates pending operations, so nightly repeats stay idempotent.
  try {
    const consolidation = await client.triggerConsolidation(options.bankId);
    result.consolidationsTriggered = 1;
    result.consolidationDeduplicated = consolidation.deduplicated;
  } catch {
    // Consolidation is best-effort: a failed trigger does not undo the walk
    // and the checkpoint stays valid for the next pass.
    result.consolidationsTriggered = 0;
  }

  if ((nowMs = clock()) >= deadline) {
    result.finishedAtMs = nowMs;
    return result;
  }

  // Phase 3 — refresh only what the server flags stale. `is_stale` is
  // computed by Hindsight from the model's own scope, so a second pass
  // observes fresh models and skips them: no duplicate refreshes.
  const models = await listMentalModelsWithinBudget(client, options.bankId, modelPageSize, clock, deadline);
  if (models !== null) {
    for (const model of models.items) {
      if (result.modelsRefreshed >= maxModelRefreshes) break;
      if ((nowMs = clock()) >= deadline) break;
      if (model.isStale !== true) {
        result.modelsSkippedFresh += 1;
        continue;
      }
      try {
        await client.refreshMentalModel(options.bankId, model.id);
        result.modelsRefreshed += 1;
      } catch {
        // A failed refresh is skipped, not fatal: the model stays flagged
        // stale server-side and the next pass will pick it up again.
      }
    }
  }

  // If the loop above stopped on an expired budget, nowMs is that exact
  // observation; otherwise take the actual end-of-pass time.
  result.finishedAtMs = nowMs >= deadline ? nowMs : clock();
  return result;
}

/** Scan mental models in bounded pages; null means the scan never started. */
async function listMentalModelsWithinBudget(
  client: HindsightClient,
  bankId: string,
  pageSize: number,
  clock: Clock,
  deadline: number,
): Promise<BankMentalModelsPage | null> {
  const collected: BankMentalModelsPage = { items: [], total: 0, limit: pageSize, offset: 0 };
  let offset = 0;
  try {
    while (clock() < deadline) {
      const page = await client.listMentalModels(bankId, pageSize, offset);
      collected.items.push(...page.items);
      collected.total = page.total;
      collected.offset = offset;
      offset += page.items.length;
      if (offset >= page.total || page.items.length === 0) break;
    }
  } catch {
    // Models unknown — skip refresh entirely rather than guessing.
    return null;
  }
  return collected;
}

function normalizePageSize(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const floor = Math.floor(value);
  return floor >= 1 ? Math.min(floor, 500) : fallback;
}

function normalizeCap(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const floor = Math.floor(value);
  return floor >= 0 ? floor : fallback;
}
