// server/src/myrmidon/bot-containers/fleet-replica-lane.ts
//
// myrmidon(1.6.6 REMOTE-SITES-T4): the replica lane (remote-sites-v2 4.4). Every 15 minutes the
// board pulls a snapshot of each bot of a reachable remote site into its replica store, so that
// when the site is lost the failover has a datadir to restore from.
//
// One snapshot at a time: a datadir is gigabytes and the link is IPsec. A site that missed a
// probe is skipped (its snapshot would only time out), and so is a site the monitor has not
// probed yet. The snapshot is the site-agent's file-level stream of a running bot: a SQLite file
// in the middle of a write can be captured between its WAL and its database file. The restore
// verifies the archive's manifest, not the databases inside; that is the price of a replica
// without a stop, and it is why the card of a failed-over bot carries "data as of" in the move's
// phase log.

import type { Readable } from "node:stream";
import { laneInterval } from "../monitoring/board-load/lanes.js";
import type { MonitoredSite, SiteBot } from "./site-health-store.js";

export const FLEET_REPLICA_INTERVAL_MS = 15 * 60_000;

export interface FleetReplicaLaneDeps {
  listSites(): Promise<MonitoredSite[]>;
  listBots(site: MonitoredSite): Promise<SiteBot[]>;
  snapshot(site: MonitoredSite, botKey: string): Promise<Readable>;
  write(siteName: string, botKey: string, stream: Readable): Promise<{ capturedAt: Date; bytes: number }>;
  intervalMs?: number;
  log?: {
    info(fields: object, message: string): void;
    warn(fields: object, message: string): void;
    error(fields: object, message: string): void;
  };
}

export interface FleetReplicaPassResult {
  replicated: string[];
  failed: string[];
  skippedSites: string[];
}

function siteAnswers(site: MonitoredSite): boolean {
  const snapshot = site.health?.snapshot as { missCount?: unknown } | undefined;
  return snapshot !== undefined && snapshot.missCount === 0;
}

export function startFleetReplicaLane(deps: FleetReplicaLaneDeps): { stop(): void; tick(): Promise<FleetReplicaPassResult> } {
  let running = false;

  async function tick(): Promise<FleetReplicaPassResult> {
    const result: FleetReplicaPassResult = { replicated: [], failed: [], skippedSites: [] };
    if (running) return result;
    running = true;
    try {
      for (const site of await deps.listSites()) {
        if (!siteAnswers(site)) {
          result.skippedSites.push(site.name);
          continue;
        }
        for (const bot of await deps.listBots(site)) {
          try {
            const stored = await deps.write(site.name, bot.botKey, await deps.snapshot(site, bot.botKey));
            result.replicated.push(bot.botKey);
            deps.log?.info({ site: site.name, botKey: bot.botKey, bytes: stored.bytes }, "fleet replica stored");
          } catch (err) {
            result.failed.push(bot.botKey);
            deps.log?.error({ site: site.name, botKey: bot.botKey, err }, "fleet replica failed; the previous one is kept");
          }
        }
      }
      return result;
    } finally {
      running = false;
    }
  }

  const timer = laneInterval(
    "bot_reconcile",
    deps.intervalMs ?? FLEET_REPLICA_INTERVAL_MS,
    () => tick(),
    (err) => deps.log?.error({ err }, "fleet replica lane error"),
  );
  timer.unref?.();
  return { stop: () => clearInterval(timer), tick };
}
