// myrmidon(1.6.9, OPE-13419): the process-wide disk budget gate of the run-start gate.
// Measures the physical bot volume through dockergate (the same C5 answer the
// quota guard reads); without dockergate the gate is inert.

import { partitionClientFromEnv } from "../host-disk/dockergate.js";
import {
  HOST_GC_REQUEST_FILE_ENV,
  createDiskBudgetGate,
  createHostGcRequestFileWriter,
  type DiskBudgetGate,
} from "./disk-budget.js";

let current: DiskBudgetGate | null = null;

export function getDiskBudgetGate(): DiskBudgetGate {
  if (!current) {
    const client = partitionClientFromEnv();
    const requestFile = process.env[HOST_GC_REQUEST_FILE_ENV]?.trim() || null;
    current = createDiskBudgetGate({
      measure: async () => {
        const usage = client ? await client.readPartitionUsage() : null;
        return usage ? { freeBytes: usage.freeBytes, totalBytes: usage.totalBytes } : null;
      },
      requestGc: requestFile ? createHostGcRequestFileWriter(requestFile) : async () => false,
      gcConfigured: requestFile !== null,
    });
  }
  return current;
}

/** Test seam: replaces (or, with null, resets) the process-wide gate. */
export function setDiskBudgetGateForTests(gate: DiskBudgetGate | null): void {
  current = gate;
}
