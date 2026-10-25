// server/src/myrmidon/bot-containers/site-return-reconcile.ts
//
// myrmidon(1.6.6 REMOTE-SITES-T4): the registry reconciliation of a site that came back
// (remote-sites-v2 4.3: reconnect, reconcile the registry, stop what is foreign, resume).
//
// "Registry" is the board's: the bots whose card names this site as their host. "Containers" are
// the bot containers the site-agent reports (GET /v1/bots lists the bots enrolled on the site;
// containers the agent does not know, such as the hand-run work bots, are not in that list and
// are never touched). Every container on the site whose bot is not in the registry of the site is
// foreign and is stopped:
//
//   - a bot that a failover moved off the site: its old copy may start by itself (restart policy)
//     and would run beside the new one, so it is stopped AND its datadir is set aside;
//   - any other bot that is not in the registry of this site (moved by hand, removed, or the card
//     names another host): stopped; its datadir is left where it is, nobody decided to discard it;
//   - a bot with an unfinished move is left alone: the move owns both of its sites.
//
// Resume is not done here: the drain is lifted by the operator or by the site's autoResume label.
// The pass is idempotent (a stopped container is not stopped again) and throws, after trying every
// container, when any step failed, so the monitor repeats it on the next tick.

export interface SiteContainer {
  botKey: string;
  state: string;
}

export interface SiteReturnReconcileDeps {
  /** Bot containers the site-agent reports. */
  listContainers(): Promise<SiteContainer[]>;
  /** Bots whose card names this site (the registry of the site). */
  registryBotKeys(): Promise<ReadonlySet<string>>;
  /** Bots that a replica failover moved off this site. */
  failedOverBotKeys(): Promise<ReadonlySet<string>>;
  /** Bots with an unfinished move. */
  movingBotKeys(): Promise<ReadonlySet<string>>;
  stop(botKey: string): Promise<void>;
  /** Sets the datadir aside on the site. */
  quarantine(botKey: string): Promise<void>;
  log?: { warn(fields: object, message: string): void };
}

export interface SiteReturnReconcileResult {
  stopped: string[];
  quarantined: string[];
  kept: string[];
}

const RUNNING_STATES = new Set(["running", "unhealthy"]);

export async function reconcileSiteReturn(siteName: string, deps: SiteReturnReconcileDeps): Promise<SiteReturnReconcileResult> {
  const [containers, registry, failedOver, moving] = await Promise.all([
    deps.listContainers(),
    deps.registryBotKeys(),
    deps.failedOverBotKeys(),
    deps.movingBotKeys(),
  ]);
  const result: SiteReturnReconcileResult = { stopped: [], quarantined: [], kept: [] };
  const problems: string[] = [];

  for (const container of containers) {
    const { botKey } = container;
    if (moving.has(botKey) || registry.has(botKey)) {
      result.kept.push(botKey);
      continue;
    }
    // Here: not in the registry of this site (a bot moved back to the site is in it again).
    try {
      if (RUNNING_STATES.has(container.state)) {
        await deps.stop(botKey);
        result.stopped.push(botKey);
      }
      if (failedOver.has(botKey)) {
        await deps.quarantine(botKey);
        result.quarantined.push(botKey);
      }
      deps.log?.warn({ site: siteName, botKey, failedOver: failedOver.has(botKey) }, "returned site: foreign container handled");
    } catch (err) {
      problems.push(`${botKey}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // A failed-over bot that the site-agent no longer lists may still have a datadir: set it aside too.
  const listed = new Set(containers.map((c) => c.botKey));
  for (const botKey of failedOver) {
    if (listed.has(botKey) || registry.has(botKey) || moving.has(botKey)) continue;
    try {
      await deps.quarantine(botKey);
      result.quarantined.push(botKey);
    } catch (err) {
      problems.push(`${botKey}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (problems.length > 0) throw new Error(`return reconciliation of "${siteName}" incomplete: ${problems.join("; ")}`);
  return result;
}
