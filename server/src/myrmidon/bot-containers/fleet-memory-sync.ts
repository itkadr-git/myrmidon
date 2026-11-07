// server/src/myrmidon/bot-containers/fleet-memory-sync.ts
//
// myrmidon(1.6.6 C-MEM): the memory sync of execution sites.
//
// The primary work-memory of a remote site is its own hindsight-work: bots of the site recall and
// retain there, never over the link to the board. The board keeps a replica of it in the
// `fleet-work-replica` bank (by default). A sync is: ask the site-agent for the bank export
// (POST /v1/memory/export, a hindsight transfer archive), import it into the replica bank in
// `merge` mode with `skip` on conflicting document ids, and write the attempt into the journal
// (myrmidon_fleet_memory_syncs).
//
// Degradation: a broken link or a failing import never throws out of here. The attempt is
// journaled as failed, the replica stays as it was, the site keeps working on its local memory,
// and the lane tries again on its next tick (the catch-up). Because the import skips documents
// the replica already holds, a retry after a half-finished import cannot duplicate them.

import { laneInterval } from "../monitoring/board-load/lanes.js";
import type { FleetMemorySyncRecord, FleetMemorySyncStore, MemorySyncKind } from "./fleet-memory-sync-store.js";
import type { MonitoredSite, SiteBot } from "./site-health-store.js";

export const FLEET_MEMORY_REPLICA_BANK = "fleet-work-replica";
export const FLEET_MEMORY_SYNC_INTERVAL_MS = 15 * 60_000;
/** The hour (UTC) after which the nightly sync of a site is due. */
export const FLEET_MEMORY_SYNC_DEFAULT_HOUR_UTC = 20; // 04:00 in UTC+8
/** An attempt still `running` after this long belongs to a process that is gone. */
export const FLEET_MEMORY_SYNC_STALE_MS = 60 * 60_000;
/** A forced sync before a move waits this long for the site, then lets the move go on. */
export const FLEET_MEMORY_FORCED_TIMEOUT_MS = 5 * 60_000;

type Log = {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
  error(fields: object, message: string): void;
};

export interface FleetMemorySyncDeps {
  store: FleetMemorySyncStore;
  targetBank?: string;
  /** The hindsight export archive of the site's bank, read through a bot enrolled on the site. */
  exportArchive(site: { companyId: string; name: string }, botKey: string): Promise<Buffer>;
  /** Merges the archive into the replica bank; the counts are null when the service gives none. */
  importArchive(bank: string, archive: Buffer): Promise<{ imported: number | null; skipped: number | null }>;
  staleAfterMs?: number;
  now?: () => Date;
  log?: Log;
}

export type FleetMemorySyncOutcome =
  | { outcome: "ok"; record: FleetMemorySyncRecord }
  | { outcome: "failed"; record: FleetMemorySyncRecord; error: string }
  /** Another attempt holds the site's slot. */
  | { outcome: "busy" };

export interface FleetMemorySyncService {
  syncSite(params: {
    companyId: string;
    siteName: string;
    botKey: string;
    kind: MemorySyncKind;
    moveId?: string | null;
  }): Promise<FleetMemorySyncOutcome>;
  readonly targetBank: string;
}

function describeError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

export function createFleetMemorySyncService(deps: FleetMemorySyncDeps): FleetMemorySyncService {
  const targetBank = deps.targetBank ?? FLEET_MEMORY_REPLICA_BANK;
  const now = deps.now ?? (() => new Date());

  return {
    targetBank,

    async syncSite(params) {
      const record = await deps.store.begin({
        companyId: params.companyId,
        siteName: params.siteName,
        kind: params.kind,
        targetBank,
        botKey: params.botKey,
        moveId: params.moveId ?? null,
        staleAfterMs: deps.staleAfterMs ?? FLEET_MEMORY_SYNC_STALE_MS,
        now: now(),
      });
      if (!record) return { outcome: "busy" };

      let archiveBytes: number | null = null;
      try {
        const archive = await deps.exportArchive({ companyId: params.companyId, name: params.siteName }, params.botKey);
        archiveBytes = archive.length;
        if (archiveBytes === 0) throw new Error("the site exported an empty archive");
        const counts = await deps.importArchive(targetBank, archive);
        await deps.store.finish(
          record.id,
          { status: "ok", archiveBytes, documentsImported: counts.imported, documentsSkipped: counts.skipped },
          now(),
        );
        deps.log?.info({ site: params.siteName, kind: params.kind, archiveBytes, ...counts }, "fleet memory synced");
        return { outcome: "ok", record: { ...record, status: "ok", archiveBytes, documentsImported: counts.imported, documentsSkipped: counts.skipped } };
      } catch (err) {
        const error = describeError(err);
        // The journal write is the one thing that must not hide the original failure.
        await deps.store.finish(record.id, { status: "failed", archiveBytes, error }, now()).catch((journalErr) => {
          deps.log?.error({ site: params.siteName, err: journalErr }, "fleet memory sync: the journal write failed");
        });
        deps.log?.warn({ site: params.siteName, kind: params.kind, error }, "fleet memory sync failed; the replica is kept and the lane retries");
        return { outcome: "failed", record: { ...record, status: "failed", archiveBytes, error }, error };
      }
    },
  };
}

/** The most recent moment the nightly sync was due: today at `hourUtc`, or yesterday's when that is still ahead. */
export function lastScheduledAt(at: Date, hourUtc: number): Date {
  const today = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), hourUtc);
  return new Date(today <= at.getTime() ? today : today - 24 * 60 * 60_000);
}

export interface FleetMemorySyncLaneDeps {
  service: FleetMemorySyncService;
  store: FleetMemorySyncStore;
  listSites(): Promise<MonitoredSite[]>;
  listBots(site: MonitoredSite): Promise<SiteBot[]>;
  intervalMs?: number;
  hourUtc?: number;
  now?: () => Date;
  log?: Log;
}

export interface FleetMemorySyncPassResult {
  synced: string[];
  failed: string[];
  /** Sites with nothing to do: not due, not answering, or without a bot to read through. */
  skippedSites: string[];
}

function siteAnswers(site: MonitoredSite): boolean {
  const snapshot = site.health?.snapshot as { missCount?: unknown } | undefined;
  return snapshot !== undefined && snapshot.missCount === 0;
}

/**
 * The nightly sync lane (`myrmidon-memory-sync`). A site is due when no sync of it succeeded since
 * the last scheduled moment; a failed attempt therefore stays due and is retried on every tick
 * until one succeeds (the catch-up after a broken link).
 */
export function startFleetMemorySyncLane(deps: FleetMemorySyncLaneDeps): { stop(): void; tick(): Promise<FleetMemorySyncPassResult> } {
  const now = deps.now ?? (() => new Date());
  const hourUtc = deps.hourUtc ?? FLEET_MEMORY_SYNC_DEFAULT_HOUR_UTC;
  let running = false;

  async function tick(): Promise<FleetMemorySyncPassResult> {
    const result: FleetMemorySyncPassResult = { synced: [], failed: [], skippedSites: [] };
    if (running) return result;
    running = true;
    try {
      for (const site of await deps.listSites()) {
        const at = now();
        const lastOk = await deps.store.lastOkAt(site.companyId, site.name);
        if (lastOk && lastOk.getTime() >= lastScheduledAt(at, hourUtc).getTime()) {
          result.skippedSites.push(site.name);
          continue;
        }
        if (!siteAnswers(site)) {
          result.skippedSites.push(site.name);
          continue;
        }
        const bot = (await deps.listBots(site))[0];
        if (!bot) {
          result.skippedSites.push(site.name);
          continue;
        }
        const done = await deps.service.syncSite({ companyId: site.companyId, siteName: site.name, botKey: bot.botKey, kind: "nightly" });
        if (done.outcome === "ok") result.synced.push(site.name);
        else if (done.outcome === "failed") result.failed.push(site.name);
        else result.skippedSites.push(site.name);
      }
      return result;
    } finally {
      running = false;
    }
  }

  const timer = laneInterval(
    "bot_reconcile",
    deps.intervalMs ?? FLEET_MEMORY_SYNC_INTERVAL_MS,
    () => tick(),
    (err) => deps.log?.error({ err }, "fleet memory sync lane error"),
  );
  timer.unref?.();
  return { stop: () => clearInterval(timer), tick };
}

/**
 * The sync right before a planned move, so that the replica holds what the site knew when the
 * bot left. Best effort and bounded: the move must not hang on a slow link, so a failure or the
 * timeout is journaled/logged and the move goes on.
 */
export async function forcedSyncBeforeMove(
  service: FleetMemorySyncService,
  params: { companyId: string; siteName: string; botKey: string; moveId: string },
  opts: { timeoutMs?: number; log?: Log } = {},
): Promise<FleetMemorySyncOutcome | { outcome: "timeout" }> {
  const timeoutMs = opts.timeoutMs ?? FLEET_MEMORY_FORCED_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ outcome: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ outcome: "timeout" }), timeoutMs);
    timer.unref?.();
  });
  try {
    const result = await Promise.race([service.syncSite({ ...params, kind: "forced" }), timeout]);
    if (result.outcome !== "ok") {
      opts.log?.warn({ site: params.siteName, botKey: params.botKey, outcome: result.outcome }, "forced memory sync before move did not complete; the move goes on");
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}
