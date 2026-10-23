// server/src/myrmidon/bot-containers/site-failover-orchestrator.ts
//
// myrmidon(1.6.6 REMOTE-SITES-T4): failover of a lost remote site (remote-sites-v2 4.2 and 4.3).
//
// Called once the reducer says the site has been unavailable for 10 minutes (and again, paced,
// while bots remain on it). For each bot whose card still names the lost site:
//
//   pinned bot            -> never moved: marked unavailable, the operator is alerted;
//   no replica on disk    -> not moved: the site is dead, there is no datadir to restore from.
//                            Its runs are left alone (a returning site's gateway still holds
//                            them and the reattach sweep picks them up);
//   otherwise             -> 1. its running runs are finalized as failed(site_lost) with a
//                            retry queued (an atomic claim on each run, see site-lost-claim.ts),
//                            so the move's maintenance window does not wait on a dead gateway;
//                            2. the bot is moved to the reserve site from its last replica.
//                            The retry runs after the window closes, against the new host.
//
// The move service owns the atomic claim of the bot (one unfinished move per bot), the restore
// and the rollback; a repeated call for a bot that is already moved finds it no longer on the
// site, and one whose move is under way gets a claim conflict and is left to that move.
// Persistence, replica disk, runs and moves stay behind injected ports.

import { recordFleetExecRetry, recordFleetMove } from "./fleet-site-metrics.js";

export interface FailoverBot {
  botKey: string;
  companyId: string;
  pinned: boolean;
}

export interface SiteFailoverDeps {
  listBots(): Promise<FailoverBot[]>;
  /** The site the bots go to: the reserve of the company (the board's own host by default). */
  selectReserve(companyId: string): Promise<string | null>;
  hasReplica(botKey: string): Promise<boolean>;
  /** Finalizes the bot's running runs as site_lost and queues their retries; returns how many. */
  requeueRuns(botKey: string, companyId: string): Promise<number>;
  /** Moves the bot from its replica; resolves with whether the move ended in "done". */
  moveBot(params: { companyId: string; botKey: string; dstSite: string }): Promise<{ ok: boolean; claimed: boolean }>;
  /** Alerts that a pinned bot sits on the lost site. */
  markUnavailable(params: { companyId: string; botKey: string; reason: "pinned" | "no_replica" | "no_reserve" }): Promise<void>;
  log?: { warn(fields: object, message: string): void; error(fields: object, message: string): void };
}

export interface SiteFailoverResult {
  moved: string[];
  unavailable: string[];
  skipped: string[];
  requeuedRuns: number;
}

export async function failoverSite(siteName: string, deps: SiteFailoverDeps): Promise<SiteFailoverResult> {
  const result: SiteFailoverResult = { moved: [], unavailable: [], skipped: [], requeuedRuns: 0 };
  for (const bot of await deps.listBots()) {
    try {
      if (bot.pinned) {
        await deps.markUnavailable({ companyId: bot.companyId, botKey: bot.botKey, reason: "pinned" });
        result.unavailable.push(bot.botKey);
        continue;
      }
      if (!(await deps.hasReplica(bot.botKey))) {
        await deps.markUnavailable({ companyId: bot.companyId, botKey: bot.botKey, reason: "no_replica" });
        recordFleetMove("unavailable");
        result.unavailable.push(bot.botKey);
        continue;
      }
      const dstSite = await deps.selectReserve(bot.companyId);
      if (!dstSite) {
        await deps.markUnavailable({ companyId: bot.companyId, botKey: bot.botKey, reason: "no_reserve" });
        recordFleetMove("unavailable");
        result.unavailable.push(bot.botKey);
        continue;
      }

      const requeued = await deps.requeueRuns(bot.botKey, bot.companyId);
      result.requeuedRuns += requeued;
      for (let i = 0; i < requeued; i += 1) recordFleetExecRetry(siteName);

      const moved = await deps.moveBot({ companyId: bot.companyId, botKey: bot.botKey, dstSite });
      if (!moved.claimed) {
        // Another process holds the bot's move; it is not ours to count or to repeat.
        result.skipped.push(bot.botKey);
        continue;
      }
      if (moved.ok) {
        recordFleetMove("done");
        result.moved.push(bot.botKey);
      } else {
        recordFleetMove("failed");
        result.skipped.push(bot.botKey);
      }
    } catch (err) {
      deps.log?.error({ siteName, botKey: bot.botKey, err }, "bot failover failed");
      recordFleetMove("failed");
      result.skipped.push(bot.botKey);
    }
  }
  return result;
}
