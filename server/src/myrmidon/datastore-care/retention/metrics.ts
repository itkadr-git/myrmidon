// server/src/myrmidon/datastore-care/retention/metrics.ts
//
// myrmidon(1.6.6 OPE-9967): observability metrics for datastore retention compaction.
// Tracks consecutive and total statement timeouts without progress.

export interface DatastoreCareRetentionMetricsSnapshot {
  consecutiveTimeouts: number;
  timeoutsTotal: number;
}

export interface DatastoreCareRetentionMetricsRegistry {
  recordTimeout(consecutive: number): void;
  recordSuccess(): void;
  read(): DatastoreCareRetentionMetricsSnapshot;
  reset(): void;
}

export function createDatastoreCareRetentionMetricsRegistry(): DatastoreCareRetentionMetricsRegistry {
  let consecutiveTimeouts = 0;
  let timeoutsTotal = 0;

  return {
    recordTimeout(consecutive: number): void {
      consecutiveTimeouts = consecutive;
      timeoutsTotal += 1;
    },
    recordSuccess(): void {
      consecutiveTimeouts = 0;
    },
    read(): DatastoreCareRetentionMetricsSnapshot {
      return { consecutiveTimeouts, timeoutsTotal };
    },
    reset(): void {
      consecutiveTimeouts = 0;
      timeoutsTotal = 0;
    },
  };
}

export const datastoreRetentionMetrics = createDatastoreCareRetentionMetricsRegistry();
