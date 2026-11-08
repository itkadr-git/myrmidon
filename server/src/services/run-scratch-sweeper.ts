import {
  recordHeartbeatRunScratchSweep,
  sweepHeartbeatRunScratch,
  type HeartbeatRunScratchSweepResult,
} from "./run-scratch.js";

// myrmidon(1.6.6 TMP-HYGIENE): periodic janitor of orphaned heartbeat run scratch
// directories. The interval and the TTL come from the product settings
// MYRMIDON_RUN_SCRATCH_SWEEP_INTERVAL_MINUTES and MYRMIDON_RUN_SCRATCH_TTL_HOURS.

export const DEFAULT_RUN_SCRATCH_SWEEP_INTERVAL_MINUTES = 15;
export const DEFAULT_RUN_SCRATCH_TTL_HOURS = 36;

export interface RunScratchSweeperConfig {
  intervalMs: number;
  ttlMs: number;
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function resolveRunScratchSweeperConfig(read: (name: string) => string | undefined): RunScratchSweeperConfig {
  return {
    intervalMs:
      positiveNumber(read("RUN_SCRATCH_SWEEP_INTERVAL_MINUTES"), DEFAULT_RUN_SCRATCH_SWEEP_INTERVAL_MINUTES) *
      60_000,
    ttlMs: positiveNumber(read("RUN_SCRATCH_TTL_HOURS"), DEFAULT_RUN_SCRATCH_TTL_HOURS) * 3_600_000,
  };
}

export interface RunScratchSweeperLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

/** Runs one sweep now, records the volume for /metrics, never throws. */
export async function runRunScratchSweep(input: {
  ttlMs: number;
  root?: string;
  now?: Date;
  logger: RunScratchSweeperLogger;
}): Promise<HeartbeatRunScratchSweepResult | null> {
  try {
    const result = await sweepHeartbeatRunScratch({ root: input.root, now: input.now, ttlMs: input.ttlMs });
    recordHeartbeatRunScratchSweep(result, input.now);
    if (result.removed > 0) input.logger.info({ ...result }, "Swept orphaned heartbeat run scratch directories");
    return result;
  } catch (err) {
    input.logger.warn({ err }, "Heartbeat run scratch sweep failed");
    return null;
  }
}

/**
 * Starts the periodic sweep (first pass immediately). Passes are chained with
 * a re-armed, unref-ed timeout so two sweeps never overlap.
 */
export function startRunScratchSweeper(input: {
  config: RunScratchSweeperConfig;
  logger: RunScratchSweeperLogger;
  root?: string;
}): { stop: () => void } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const pass = async () => {
    await runRunScratchSweep({ ttlMs: input.config.ttlMs, root: input.root, logger: input.logger });
    if (stopped) return;
    timer = setTimeout(() => void pass(), input.config.intervalMs);
    timer.unref?.();
  };
  void pass();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
