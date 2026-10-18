import type { HostDiskConsumerEntry, HostDiskUsageSample } from "@paperclipai/shared";

/**
 * In-process state of the host disk sweep (myrmidon BOT-DISK, part E).
 *
 * The sweep keeps a ring of the newest samples per observed path, so the
 * growth rate per hour needs no table: one sample per sweep, a bounded
 * window, and the slope between the oldest and the newest sample of the
 * window. State is deliberately memory-only — after a restart the first hour
 * has no growth number yet, which the signal says plainly rather than
 * inventing one.
 */

export interface HostDiskSweepResult {
  at: string;
  measuredPath: string | null;
  usedPercent: number | null;
  usedBytes: number | null;
  totalBytes: number | null;
  freeBytes: number | null;
  overThreshold: boolean;
  thresholdPercent: number | null;
  growthBytesPerHour: number | null;
  consumers: HostDiskConsumerEntry[];
  signalled: boolean;
  error: string | null;
  /**
   * myrmidon(1.6.5 F-03): the measurement state. `measured` — the data root
   * exists and `statfs` answered; `unmeasured` — the path is missing or
   * unreadable, so every numeric field above is null and `error` carries the
   * reason an operator can act on. A state string lets an operator check
   * (`post-boot-check.sh`, the API reader) tell "never measured yet"
   * (result absent) from "tried and failed" (result present, unmeasured).
   */
  state: "measured" | "unmeasured";
  /**
   * myrmidon(1.6.5 F-03): per-path usage for every measured path (the data
   * root plus each consumer path whose statfs answered). The data root stays
   * the main result in the flat fields above; this list is how a consumer
   * that lives on a DIFFERENT filesystem than the data root becomes visible
   * in the API instead of only in the threshold signal.
   */
  measurements: HostDiskPathMeasurement[];
}

export interface HostDiskPathMeasurement {
  path: string;
  usedPercent: number;
  usedBytes: number;
  totalBytes: number;
  freeBytes: number;
}

export class HostDiskSampleRing {
  private readonly samples: HostDiskUsageSample[] = [];

  constructor(private readonly maxSamples: number) {}

  push(sample: HostDiskUsageSample): void {
    this.samples.push(sample);
    if (this.samples.length > this.maxSamples) this.samples.shift();
  }

  list(): HostDiskUsageSample[] {
    return [...this.samples];
  }

  clear(): void {
    this.samples.length = 0;
  }
}
