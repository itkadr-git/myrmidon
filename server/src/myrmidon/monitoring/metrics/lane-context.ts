// server/src/myrmidon/monitoring/metrics/lane-context.ts
//
// myrmidon(1.6.5-PROCS-T02): the "lane" label of board work. Background passes
// (the scheduler tick, the execution-control sweeps, chat and bot
// reconciliation) and the API request handlers each run their work inside
// `withLane(lane, fn)`, so every read they make can say which part of the
// board asked for it. The storage holds no counters and no state of its own:
// it only answers `currentLane()` — the seam the DB query accounting and the
// lane counters consume.
//
// Work that runs outside every `withLane` call is "unlabeled", which is
// exactly today's single-process behaviour: labelling is additive measurement,
// it changes no control flow and no setting.

import { AsyncLocalStorage } from "node:async_hooks";

/** The lane reported outside every `withLane` call. */
export const UNLABELED_LANE = "unlabeled";

const laneStorage = new AsyncLocalStorage<string>();

/**
 * Runs `fn` with `lane` as the current label. Nested calls shadow the outer
 * label and restore it when they return; a blank label counts as unlabeled.
 * The label is metrics data only — never derive behaviour from it.
 */
export function withLane<T>(lane: string, fn: () => T): T {
  const label = lane.trim();
  return laneStorage.run(label === "" ? UNLABELED_LANE : label, fn);
}

/** The lane of the work running right now ("unlabeled" outside a run). */
export function currentLane(): string {
  return laneStorage.getStore() ?? UNLABELED_LANE;
}