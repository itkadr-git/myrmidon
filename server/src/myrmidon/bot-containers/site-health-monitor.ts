// server/src/myrmidon/bot-containers/site-health-monitor.ts
//
// myrmidon(1.6.6 REMOTE-SITES-T4): the site-monitor lane (remote-sites-v2 4.1 and 4.2).
//
// Every 30 s each watched site is probed and the result goes through the pure health reducer
// (packages/shared remote-sites/health-reducer, OPE-8106). The monitor owns what the reducer does
// not: persistence of its snapshot, the registry status, and the effects of its intents.
//
//   drain      (3 misses, 90 s)    -> registry status active -> draining: the scheduler places
//                                     nothing there; the monitor remembers it drained the site
//                                     itself (autoDrained), so a status an operator set is never
//                                     treated as its own;
//   failover   (10 min unavailable)-> the failover orchestrator moves the bots off; while bots are
//                                     left it is called again, at most every FAILOVER_RETRY_MS;
//   quarantine (bad cert/protocol) -> status -> quarantined: the site's client is dropped and
//                                     nothing goes there until the owner decides.
//
// Return of a site: after three consecutive answers the monitor runs the return pass once (stop
// and quarantine the copies of bots that were failed over, see reconcileReturned) and only then,
// when the site opted in with the label autoResume=true, lifts the drain. Without the label the
// site stays draining until an operator resumes it: bots that moved away have stale data on it.
//
// Pinned bots: the reducer holds its failover intent back while pinnedBotCount > 0, which would
// keep the unpinned bots of the site from moving too. The pinned rule is per bot (the
// orchestrator never moves a pinned bot), so the snapshot is always fed pinnedBotCount 0.

import {
  createSiteHealthSnapshot,
  reduceSiteHealth,
  SITE_HEALTH_POLL_INTERVAL_MS,
  type SiteHealthSnapshot,
} from "@myrmidon/shared/remote-sites/health-reducer";
import type { FleetSiteHealth } from "@myrmidon/db";
import { recordFleetSiteHealth } from "./fleet-site-metrics.js";
import type { SiteProbeOutcome } from "./site-health-probe.js";
import type { MonitoredSite, SiteStatus } from "./site-health-store.js";
import type { SiteFailoverResult } from "./site-failover-orchestrator.js";

export const SITE_HEALTH_MONITOR_INTERVAL_MS = SITE_HEALTH_POLL_INTERVAL_MS;
/** Consecutive answers before a returned site is reconciled. */
export const SITE_RETURN_PASSES = 3;
/** Pace of repeated failover calls while bots are left on the lost site. */
export const FAILOVER_RETRY_MS = 5 * 60_000;

export interface SiteHealthMonitorDeps {
  listSites(): Promise<MonitoredSite[]>;
  probe(site: MonitoredSite): Promise<SiteProbeOutcome>;
  saveHealth(siteId: string, health: FleetSiteHealth, lastSeenAt: Date | null): Promise<void>;
  setStatus(siteId: string, from: readonly string[], to: SiteStatus): Promise<boolean>;
  failover(site: MonitoredSite): Promise<SiteFailoverResult>;
  /** Stops and sets aside the copies of failed-over bots on a site that came back. */
  reconcileReturned(site: MonitoredSite): Promise<void>;
  now?: () => number;
  log?: {
    info(fields: object, message: string): void;
    warn(fields: object, message: string): void;
    error(fields: object, message: string): void;
  };
}

export interface SiteHealthPollResult {
  siteId: string;
  siteName: string;
  state: SiteHealthSnapshot["state"];
  intents: string[];
  status: string;
}

function loadSnapshot(site: MonitoredSite, autoDrained: boolean): SiteHealthSnapshot {
  const stored = (site.health?.snapshot ?? {}) as unknown as Partial<SiteHealthSnapshot>;
  return createSiteHealthSnapshot({
    state: stored.state ?? "unknown",
    lastSeenAt: typeof stored.lastSeenAt === "number" ? stored.lastSeenAt : null,
    missCount: typeof stored.missCount === "number" ? stored.missCount : 0,
    unavailableSince: typeof stored.unavailableSince === "number" ? stored.unavailableSince : null,
    failoverIssued: stored.failoverIssued === true,
    pinnedBotCount: 0,
    // A draining status the monitor did not set is an operator's drain: the reducer keeps it.
    manualDrain: site.status === "draining" && !autoDrained,
  });
}

export function createSiteHealthMonitor(deps: SiteHealthMonitorDeps): { tick(): Promise<SiteHealthPollResult[]> } {
  const now = deps.now ?? Date.now;
  const lastFailoverAttemptAt = new Map<string, number>();
  let running = false;

  async function pollSite(site: MonitoredSite): Promise<SiteHealthPollResult> {
    const stored = site.health;
    let autoDrained = stored?.autoDrained === true;
    let status = site.status;
    const previous = loadSnapshot(site, autoDrained);
    const at = now();

    const outcome = await deps.probe(site);
    const next = reduceSiteHealth({ previous, now: at, result: outcome.result, resourceDegraded: outcome.resourceDegraded });
    const answered = outcome.result === "success";
    const recoveryPasses = answered ? (stored?.recoveryPasses ?? 0) + 1 : 0;
    let reconciled = answered ? stored?.reconciled === true : false;

    // Fence first: nothing is placed on, or moved off, a site that is not already out of placement.
    if (next.intents.includes("quarantine")) {
      if (await deps.setStatus(site.id, ["active", "draining"], "quarantined")) {
        status = "quarantined";
        autoDrained = false;
        deps.log?.error({ site: site.name, result: outcome.result }, "remote site quarantined: bad certificate or protocol");
      }
    }
    if (next.intents.includes("drain")) {
      if (await deps.setStatus(site.id, ["active"], "draining")) {
        status = "draining";
        autoDrained = true;
        deps.log?.warn({ site: site.name, missCount: next.missCount }, "remote site unreachable: draining, no new placements");
      }
    }
    // The first failover comes from the reducer's one-shot intent; later calls are paced retries.
    const failoverDue =
      autoDrained &&
      status === "draining" &&
      (next.intents.includes("failover") ||
        (previous.failoverIssued && !answered && at - (lastFailoverAttemptAt.get(site.id) ?? 0) >= FAILOVER_RETRY_MS));
    if (failoverDue) {
      lastFailoverAttemptAt.set(site.id, at);
      deps.log?.warn({ site: site.name }, "remote site lost: failing its bots over");
      const result = await deps.failover(site);
      deps.log?.warn(
        { site: site.name, moved: result.moved.length, unavailable: result.unavailable.length, skipped: result.skipped.length, requeuedRuns: result.requeuedRuns },
        "remote site failover pass finished",
      );
    }

    // Return: reconcile once after three answers, then (opt-in) lift the drain.
    if (answered && recoveryPasses >= SITE_RETURN_PASSES && !reconciled && status !== "quarantined") {
      await deps.reconcileReturned(site);
      reconciled = true;
      lastFailoverAttemptAt.delete(site.id);
    }
    if (answered && reconciled && autoDrained && status === "draining" && site.labels.autoResume === "true") {
      if (await deps.setStatus(site.id, ["draining"], "active")) {
        status = "active";
        autoDrained = false;
        deps.log?.info({ site: site.name }, "remote site returned: drain lifted (autoResume)");
      }
    }

    const { intents, ...snapshot } = next;
    await deps.saveHealth(
      site.id,
      {
        snapshot: snapshot as unknown as Record<string, unknown>,
        autoDrained,
        state: next.state,
        recoveryPasses,
        reconciled,
        updatedAt: new Date(at).toISOString(),
      },
      answered ? new Date(at) : null,
    );
    recordFleetSiteHealth(site.name, answered, snapshot.lastSeenAt);
    return { siteId: site.id, siteName: site.name, state: next.state, intents, status };
  }

  async function tick(): Promise<SiteHealthPollResult[]> {
    if (running) return [];
    running = true;
    try {
      const results: SiteHealthPollResult[] = [];
      for (const site of await deps.listSites()) {
        try {
          results.push(await pollSite(site));
        } catch (err) {
          // One site's failure (a store error, a failover that threw) never stops the others.
          deps.log?.error({ site: site.name, err }, "remote site health poll failed");
        }
      }
      return results;
    } finally {
      running = false;
    }
  }

  return { tick };
}
