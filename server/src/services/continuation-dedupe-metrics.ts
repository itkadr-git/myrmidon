import type { ContinuationDedupeMetrics } from "@myrmidon/shared";

export interface ContinuationDedupeCounterSnapshot {
  created: number;
  deduped: number;
}

export interface ContinuationDedupeMetricsRegistry {
  metrics: ContinuationDedupeMetrics;
  read(): ContinuationDedupeCounterSnapshot;
  reset(): void;
}

/** Creates an isolated process-local counter registry for tests or other processes. */
export function createContinuationDedupeMetricsRegistry(): ContinuationDedupeMetricsRegistry {
  let created = 0;
  let deduped = 0;
  return {
    metrics: {
      onContinuationCreated(_key: string): void {
        created += 1;
      },
      onContinuationDeduped(_key: string): void {
        deduped += 1;
      },
    },
    read: () => ({ created, deduped }),
    reset(): void {
      created = 0;
      deduped = 0;
    },
  };
}

/** The process-wide sink used by continuation claims and the metrics scrape. */
export const continuationDedupeMetrics = createContinuationDedupeMetricsRegistry();
