import {
  HOST_DISK_SIGNAL_INTERVAL_MS,
  HOST_DISK_THRESHOLD_EXCEEDED_ACTION,
  gigabytesFromBytes,
  hostDiskGrowthBytesPerHour,
  isHostDiskOverThreshold,
  type HostDiskConsumerEntry,
  type HostDiskSettings,
  type HostDiskUsageSample,
} from "@paperclipai/shared";
import type { LogActivityInput } from "../../services/activity-log.js";
import { measureHostDiskConsumer, readHostDiskUsage } from "./measure.js";
import { HostDiskSampleRing, type HostDiskSweepResult } from "./state.js";

/**
 * One sweep of the host disk (myrmidon BOT-DISK, part E).
 *
 * Every call: read the threshold in force (so a saved settings change applies
 * without a restart), `statfs` the data root, push the sample into the ring,
 * and when usage crosses the threshold, walk the top-level directories of the
 * data root for the biggest consumers and write one activity-log line — at
 * most once per `signalIntervalMs`, anchored on the newest line of the same
 * action, exactly like the workspace quota signal.
 *
 * The sweep is a signal, never a reaper: it deletes nothing.
 */

export interface HostDiskSweepDeps {
  /** Directory whose filesystem usage is measured (the server data root). */
  dataRootPath: string;
  /** Directories under the data root ranked as "biggest consumers" when a signal is due. */
  consumerPaths: string[];
  resolveSettings: () => Promise<HostDiskSettings>;
  logActivity: (entry: LogActivityInput) => Promise<unknown>;
  lastSignalAt: () => Promise<Date | null>;
  logger: {
    error: (entry: object, message: string) => void;
    info: (entry: object, message: string) => void;
    debug: (entry: object, message: string) => void;
  };
  signalIntervalMs?: number;
  /** Samples per path kept for the growth rate. */
  maxSamples?: number;
  measureUsage?: typeof readHostDiskUsage;
  measureConsumer?: typeof measureHostDiskConsumer;
  /** myrmidon(1.6.5-BOT-DISK-H10): dockergate client of the bot partition; null disables the partition measurement. */
  partitionClient?: import("./dockergate.js").DockergateDiskClient | null;
  /** myrmidon(1.6.5-BOT-DISK-H10): threshold state the sweep feeds with each measurement. */
  partitionRuntime?: import("./partition.js").BotPartitionThresholdRuntime | null;
  /**
   * myrmidon(1.6.5 F-03): how often an unmeasured sweep repeats the ERROR log
   * line. The transition into `unmeasured` logs one error at once; while the
   * state holds, the error repeats no more often than this interval and every
   * other tick is a debug line, so a missing path never spams the log.
   */
  unmeasuredErrorIntervalMs?: number;
  now?: () => Date;
}

export interface HostDiskSweep {
  sweep(): Promise<HostDiskSweepResult>;
  lastResult(): HostDiskSweepResult | null;
  samples(): HostDiskUsageSample[];
  consumers(): HostDiskConsumerEntry[];
}

/** myrmidon(1.6.5 F-03): default repeat interval of the unmeasured ERROR line: once an hour. */
export const HOST_DISK_UNMEASURED_ERROR_INTERVAL_MS = 60 * 60 * 1000;

/** myrmidon(1.6.5 F-03): the error text a missing/unreadable data root reports (result + log). */
export function hostDiskUnmeasuredError(dataRootPath: string): string {
  return (
    `host disk data root is missing or unreadable: ${dataRootPath} — ` +
    "point MYRMIDON_HOST_DISK_DATA_ROOT at a path mounted into the server container " +
    "(for example the host directory the board data lives on) and restart the service"
  );
}

export function createHostDiskSweep(deps: HostDiskSweepDeps): HostDiskSweep {
  const now = deps.now ?? (() => new Date());
  const measureUsage = deps.measureUsage ?? readHostDiskUsage;
  const measureConsumer = deps.measureConsumer ?? measureHostDiskConsumer;
  const signalIntervalMs = deps.signalIntervalMs ?? HOST_DISK_SIGNAL_INTERVAL_MS;
  const unmeasuredErrorIntervalMs =
    deps.unmeasuredErrorIntervalMs ?? HOST_DISK_UNMEASURED_ERROR_INTERVAL_MS;
  const ring = new HostDiskSampleRing(deps.maxSamples ?? 24);
  let lastResult: HostDiskSweepResult | null = null;
  let consumers: HostDiskConsumerEntry[] = [];
  const partitionClient = deps.partitionClient ?? null;
  const partitionRuntime = deps.partitionRuntime ?? null;
  // myrmidon(1.6.5 F-03): null = "no result yet", so the first ever sweep
  // that fails logs the transition error; `lastUnmeasuredErrorAt` throttles
  // the repeats while the path stays missing.
  let measured: boolean | null = null;
  let lastUnmeasuredErrorAt: number | null = null;

  async function sweep(): Promise<HostDiskSweepResult> {
    const settings = await deps.resolveSettings();
    const usage = await measureUsage(deps.dataRootPath);
    // myrmidon(1.6.5 F-03): every consumer path is measured too. A consumer
    // can live on another filesystem than the data root (the bot partition
    // mounted beside the board data), so its fill level is its own number,
    // not the data root's. The data root stays the main result; a consumer
    // whose statfs fails is simply absent from the list. The data root
    // measurement above is reused, not re-read.
    const measurements: HostDiskSweepResult["measurements"] = [];
    const seenMeasurementPaths = new Set<string>();
    const pushMeasurement = (pathUsage: Awaited<ReturnType<typeof measureUsage>>) => {
      if (!pathUsage) return;
      measurements.push({
        path: pathUsage.path,
        usedPercent: pathUsage.usedPercent,
        usedBytes: pathUsage.usedBytes,
        totalBytes: pathUsage.totalBytes,
        freeBytes: pathUsage.freeBytes,
      });
    };
    seenMeasurementPaths.add(deps.dataRootPath);
    pushMeasurement(usage);
    for (const pathToMeasure of deps.consumerPaths) {
      if (seenMeasurementPaths.has(pathToMeasure)) continue;
      seenMeasurementPaths.add(pathToMeasure);
      pushMeasurement(await measureUsage(pathToMeasure));
    }
    // myrmidon(1.6.5-BOT-DISK-H10): the bot partition is measured over
    // dockergate in parallel with the statfs of the server data root. When
    // dockergate answers, the card and the desired-state pressure follow the
    // partition physics; when it does not, the partition state is reset to
    // "not measured" and the statfs behaviour is exactly what part E shipped.
    const partitionUsage = partitionClient
      ? await partitionClient.readPartitionUsage()
      : null;
    if (partitionRuntime) {
      if (partitionUsage) await partitionRuntime.updateFromPartition(partitionUsage);
      else partitionRuntime.markUnmeasured();
    }
    if (!usage) {
      const error = hostDiskUnmeasuredError(deps.dataRootPath);
      const result: HostDiskSweepResult = {
        at: now().toISOString(),
        measuredPath: null,
        usedPercent: null,
        usedBytes: null,
        totalBytes: null,
        freeBytes: null,
        overThreshold: false,
        thresholdPercent: settings.usageThresholdPercent,
        growthBytesPerHour: null,
        consumers: [],
        signalled: false,
        error,
        state: "unmeasured",
        measurements,
      };
      lastResult = result;
      const atMs = now().getTime();
      if (measured !== false) {
        // First failure (startup or right after a recovery): one error line.
        deps.logger.error({ path: deps.dataRootPath }, error);
        lastUnmeasuredErrorAt = atMs;
      } else if (
        lastUnmeasuredErrorAt === null ||
        atMs - lastUnmeasuredErrorAt >= unmeasuredErrorIntervalMs
      ) {
        // The state holds: repeat the error no more often than the interval.
        deps.logger.error({ path: deps.dataRootPath }, error);
        lastUnmeasuredErrorAt = atMs;
      } else {
        deps.logger.debug({ path: deps.dataRootPath }, error);
      }
      measured = false;
      return result;
    }
    if (measured === false) {
      deps.logger.info(
        { path: usage.path },
        "host disk measurement resumed: the data root is readable again",
      );
    }
    measured = true;
    lastUnmeasuredErrorAt = null;

    const sample: HostDiskUsageSample = {
      measuredAt: now().toISOString(),
      usedPercent: usage.usedPercent,
      usedBytes: usage.usedBytes,
      totalBytes: usage.totalBytes,
    };
    ring.push(sample);
    const growthBytesPerHour = hostDiskGrowthBytesPerHour(ring.list());

    const overThreshold = isHostDiskOverThreshold(usage.usedPercent, settings.usageThresholdPercent);

    let signalled = false;
    if (overThreshold) {
      consumers = await measureConsumers();
      const last = await deps.lastSignalAt();
      const due = last === null || now().getTime() - last.getTime() >= signalIntervalMs;
      if (due) {
        await deps.logActivity({
          companyId: null as unknown as string,
          actorType: "system",
          actorId: "host-disk-sweep",
          agentId: null,
          runId: null,
          action: HOST_DISK_THRESHOLD_EXCEEDED_ACTION,
          entityType: "host_disk",
          entityId: usage.path,
          details: {
            usedPercent: usage.usedPercent,
            thresholdPercent: settings.usageThresholdPercent,
            usedGb: gigabytesFromBytes(usage.usedBytes),
            totalGb: gigabytesFromBytes(usage.totalBytes),
            freeGb: gigabytesFromBytes(usage.freeBytes),
            growthBytesPerHour,
            measuredPath: usage.path,
            consumers: consumers.map((c) => ({ path: c.path, sizeGb: gigabytesFromBytes(c.sizeBytes) })),
          },
        });
        signalled = true;
        deps.logger.info(
          { usedPercent: usage.usedPercent, thresholdPercent: settings.usageThresholdPercent },
          "host disk crossed the usage threshold",
        );
      }
    }

    const result: HostDiskSweepResult = {
      at: sample.measuredAt,
      measuredPath: usage.path,
      usedPercent: usage.usedPercent,
      usedBytes: usage.usedBytes,
      totalBytes: usage.totalBytes,
      freeBytes: usage.freeBytes,
      overThreshold,
      thresholdPercent: settings.usageThresholdPercent,
      growthBytesPerHour,
      consumers,
      signalled,
      error: null,
      state: "measured",
      measurements,
    };
    lastResult = result;
    return result;
  }

  async function measureConsumers(): Promise<HostDiskConsumerEntry[]> {
    const entries: HostDiskConsumerEntry[] = [];
    for (const directory of deps.consumerPaths) {
      const measurement = await measureConsumer(directory);
      entries.push({ path: directory, sizeBytes: measurement.sizeBytes });
    }
    entries.sort((a, b) => b.sizeBytes - a.sizeBytes || a.path.localeCompare(b.path));
    return entries;
  }

  return {
    sweep,
    lastResult: () => lastResult,
    samples: () => ring.list(),
    consumers: () => [...consumers],
  };
}
