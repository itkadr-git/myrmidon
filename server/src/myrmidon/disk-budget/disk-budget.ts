/**
 * myrmidon(1.6.9, OPE-13419): disk budget of the physical bot volume.
 *
 * On 16.11 the volume filled up to 100% and 63 runs failed in ten minutes:
 * `myr-ws open` refused the copy (BOT_DISK_QUOTA_EXCEEDED) while the run was
 * already started, so the run died. Below the minimum free space (default 5%, env MYRMIDON_DISK_BUDGET_MIN_FREE_PERCENT) on the physical volume
 * a queued run is not started and not cancelled: the same row waits in
 * `scheduled_retry` with the reason `disk_budget` (like the daily run limit and
 * the model channel pause), and the due-retry sweep brings it back to the claim
 * gate, which measures again. At the minimum free space or more the gate lets the run through.
 *
 * The first deferral also asks the host for an extraordinary cleanup (host GC,
 * `scripts/myrmidon/host-gc`). The request is a small file the host watches
 * (`MYRMIDON_HOST_GC_REQUEST_FILE`); it is single-flight and rate-limited here,
 * and host GC itself takes its own lock, so a burst of deferred runs asks once
 * and two cleanups never run together. A failed request is not an error of the
 * run: the run waits all the same and the next recheck asks again after a short
 * cooldown. A volume that cannot be measured never blocks (no data is not a
 * refusal).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Stable reason of the deferral; the same word `myr-ws open` puts into its refusal. */
export const DISK_BUDGET_REASON = "disk_budget";

/** Key of the context marker of a `scheduled_retry` run that waits for free space. */
export const DISK_BUDGET_DEFERRAL_CONTEXT_KEY = "diskBudgetDeferral";

/** Default minimum free percent of the physical volume: below it new runs wait (exactly the minimum passes). */
export const DISK_BUDGET_MIN_FREE_PERCENT = 5;
export const DISK_BUDGET_MIN_FREE_PERCENT_ENV = "MYRMIDON_DISK_BUDGET_MIN_FREE_PERCENT";

/** The minimum free percent in force: the env value when it is a number in (0, 50], else the default. */
export function resolveDiskBudgetMinFreePercent(env: Record<string, string | undefined> = process.env): number {
  const raw = env[DISK_BUDGET_MIN_FREE_PERCENT_ENV]?.trim();
  if (!raw) return DISK_BUDGET_MIN_FREE_PERCENT;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 && value <= 50 ? value : DISK_BUDGET_MIN_FREE_PERCENT;
}

/** Recheck ladder of a deferred run: 1, 2, then 5 minutes. */
export const DISK_BUDGET_RECHECK_LADDER_MS = [1, 2, 5].map((minutes) => minutes * 60_000);

/** A cleanup is requested at most once per this window while the volume stays full. */
export const DISK_BUDGET_GC_COOLDOWN_MS = 10 * 60_000;
/** After a failed request the next one may come sooner. */
export const DISK_BUDGET_GC_FAILURE_COOLDOWN_MS = 60_000;

export const HOST_GC_REQUEST_FILE_ENV = "MYRMIDON_HOST_GC_REQUEST_FILE";

export type DiskBudgetVolume = { freeBytes: number; totalBytes: number };

/** Free percent of the volume, or null when the numbers are not usable. */
export function freePercentOf(volume: DiskBudgetVolume | null | undefined): number | null {
  if (!volume) return null;
  const { freeBytes, totalBytes } = volume;
  if (!Number.isFinite(freeBytes) || !Number.isFinite(totalBytes) || totalBytes <= 0 || freeBytes < 0) return null;
  return (Math.min(freeBytes, totalBytes) / totalBytes) * 100;
}

/** True only when the volume is measured and has less than the minimum free: 4.9% blocks, 5% passes. */
export function isBelowDiskBudget(freePercent: number | null, minFreePercent: number = DISK_BUDGET_MIN_FREE_PERCENT): boolean {
  return freePercent !== null && freePercent < minFreePercent;
}

/** When a run deferred for the `count`-th time (0 = first) is looked at again. */
export function diskBudgetDueAt(now: Date, count: number): Date {
  const step = Math.min(Math.max(Number.isFinite(count) ? Math.floor(count) : 0, 0), DISK_BUDGET_RECHECK_LADDER_MS.length - 1);
  return new Date(now.getTime() + DISK_BUDGET_RECHECK_LADDER_MS[step]!);
}

export type HostGcRequestOutcome = "requested" | "cooldown" | "in_flight" | "failed" | "unconfigured";

export type DiskBudgetVerdict =
  | { blocked: false }
  | { blocked: true; freePercent: number; minFreePercent: number; gc: HostGcRequestOutcome };

export interface DiskBudgetGateDeps {
  /** Physical numbers of the bot volume; null/throw = not measured. */
  measure: () => Promise<DiskBudgetVolume | null>;
  /** Asks the host for an extraordinary cleanup; resolves false (or throws) when it could not. */
  requestGc: (info: { freePercent: number; at: Date }) => Promise<boolean>;
  /** False when no request channel exists (nothing to ask). */
  gcConfigured?: boolean;
  /** Minimum free percent; default from the env (MYRMIDON_DISK_BUDGET_MIN_FREE_PERCENT) or 5. */
  minFreePercent?: number;
  now?: () => Date;
}

export interface DiskBudgetGate {
  check(): Promise<DiskBudgetVerdict>;
}

export function createDiskBudgetGate(deps: DiskBudgetGateDeps): DiskBudgetGate {
  const now = deps.now ?? (() => new Date());
  const minFreePercent = deps.minFreePercent ?? resolveDiskBudgetMinFreePercent();
  let nextRequestAt = 0;
  let inFlight: Promise<HostGcRequestOutcome> | null = null;

  async function requestGcOnce(freePercent: number): Promise<HostGcRequestOutcome> {
    if (deps.gcConfigured === false) return "unconfigured";
    if (inFlight) return "in_flight";
    const at = now();
    if (at.getTime() < nextRequestAt) return "cooldown";
    // The window is claimed before the first await: runs claimed in parallel see "in_flight".
    const pending = (async () => {
      let ok = false;
      try {
        ok = await deps.requestGc({ freePercent, at });
      } catch {
        ok = false;
      }
      nextRequestAt = at.getTime() + (ok ? DISK_BUDGET_GC_COOLDOWN_MS : DISK_BUDGET_GC_FAILURE_COOLDOWN_MS);
      return ok ? ("requested" as const) : ("failed" as const);
    })();
    inFlight = pending;
    try {
      return await pending;
    } finally {
      inFlight = null;
    }
  }

  return {
    async check() {
      let volume: DiskBudgetVolume | null = null;
      try {
        volume = await deps.measure();
      } catch {
        volume = null;
      }
      const freePercent = freePercentOf(volume);
      if (freePercent === null || !isBelowDiskBudget(freePercent, minFreePercent)) return { blocked: false };
      const gc = await requestGcOnce(freePercent);
      return { blocked: true, freePercent, minFreePercent, gc };
    },
  };
}

/**
 * The request channel to host GC: one small JSON file, written atomically
 * (temp file + rename). The host watches it (systemd `.path` unit) and host GC
 * removes it when a pass starts, so an unconsumed file is simply replaced.
 */
export function createHostGcRequestFileWriter(filePath: string) {
  return async (info: { freePercent: number; at: Date }): Promise<boolean> => {
    const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(
        tmp,
        JSON.stringify({ reason: DISK_BUDGET_REASON, freePercent: Math.round(info.freePercent * 10) / 10, requestedAt: info.at.toISOString() }) + "\n",
        { mode: 0o644 },
      );
      await fs.rename(tmp, filePath);
      return true;
    } catch {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      return false;
    }
  };
}
