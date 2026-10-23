// myrmidon(1.6.6 REMOTE-SITES-T5): deterministic site failover policy.
// The move service owns snapshot/restore and its idempotency; this module only
// selects a reserve and applies the pinned-bot safety rule.

export interface FailoverBot {
  botKey: string;
  companyId: string;
  pinned: boolean;
}

export interface SiteFailoverDeps {
  listBots(siteName: string): Promise<FailoverBot[]>;
  selectReserve(companyId: string, failedSite: string): Promise<string | null>;
  moveBot(params: { companyId: string; botKey: string; dstSite: string }): Promise<void>;
  markUnavailable(params: { companyId: string; botKey: string; siteName: string }): Promise<void>;
  log?: { warn(fields: object, message: string): void; error(fields: object, message: string): void };
}

export interface SiteFailoverResult {
  moved: string[];
  unavailable: string[];
  skipped: string[];
}

/**
 * Moves every eligible bot once. A pinned bot is never passed to moveBot.
 * Repeated calls are safe when moveBot delegates to FleetMoveService, whose
 * move record/CAS path resumes an existing operation instead of duplicating it.
 */
export async function failoverSite(siteName: string, deps: SiteFailoverDeps): Promise<SiteFailoverResult> {
  const result: SiteFailoverResult = { moved: [], unavailable: [], skipped: [] };
  const bots = await deps.listBots(siteName);

  for (const bot of bots) {
    if (bot.pinned) {
      await deps.markUnavailable({ companyId: bot.companyId, botKey: bot.botKey, siteName });
      result.unavailable.push(bot.botKey);
      continue;
    }

    const dstSite = await deps.selectReserve(bot.companyId, siteName);
    if (!dstSite) {
      deps.log?.warn({ siteName, botKey: bot.botKey }, "no reserve site available during failover");
      result.skipped.push(bot.botKey);
      continue;
    }

    try {
      await deps.moveBot({ companyId: bot.companyId, botKey: bot.botKey, dstSite });
      result.moved.push(bot.botKey);
    } catch (err) {
      deps.log?.error({ siteName, botKey: bot.botKey, dstSite, err }, "bot failover failed");
      result.skipped.push(bot.botKey);
    }
  }

  return result;
}
