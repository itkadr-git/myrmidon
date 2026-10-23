// server/src/myrmidon/bot-containers/site-health-startup.ts
//
// myrmidon(1.6.6 REMOTE-SITES-T4): startup wiring of the site-monitor lane (30 s) and the replica
// lane (15 min), next to the site-scheduler lane (site-scheduler-startup.ts).
//
// Both are opt-in. The monitor starts only with MYRMIDON_BOT_CONTAINERS on AND MYRMIDON_SITE_HEALTH=1
// (the failover it can run moves bots and fails runs, so it is never a side effect of having a site
// in the registry). The replica lane additionally needs MYRMIDON_FLEET_REPLICA_DIR: without a store
// the monitor still probes, drains and quarantines, and the failover reports every bot of a lost
// site as unavailable instead of moving it. The monitor also needs the heartbeat service of this
// process (registerSiteLostRunFinalizer, called from index.ts); a process without one (the api
// role) does not start it, so the site is watched once per run-executing process.

import { and, eq } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@myrmidon/db";
import { logger } from "../../middleware/logger.js";
import { isBotContainersEnabled } from "./agent-config.js";
import { laneInterval } from "../monitoring/board-load/lanes.js";
import { createFleetMoveContext } from "./fleet-move-wiring.js";
import { FleetMoveError } from "./fleet-move-service.js";
import { fleetReplicaStoreFromEnv } from "./fleet-replica-store.js";
import { startFleetReplicaLane } from "./fleet-replica-lane.js";
import { fleetSiteKey } from "./fleetd-hosts.js";
import { clearFleetSiteGauges } from "./fleet-site-metrics.js";
import { failoverSite } from "./site-failover-orchestrator.js";
import { createSiteHealthMonitor, SITE_HEALTH_MONITOR_INTERVAL_MS } from "./site-health-monitor.js";
import { probeSiteHealth } from "./site-health-probe.js";
import { siteHealthStore, type MonitoredSite } from "./site-health-store.js";
import { createSiteAgentClient } from "./site-agent-client.js";
import type { FleetClientManager } from "./site-registry.js";

export const SITE_HEALTH_ENV = "MYRMIDON_SITE_HEALTH";

/** The board's own host: where a lost site's bots go (remote-sites-v2 4.2). */
export const FAILOVER_RESERVE_SITE = "local";

export function isSiteHealthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isBotContainersEnabled(env) && env[SITE_HEALTH_ENV]?.trim() === "1";
}

export type SiteLostRunFinalizer = (runId: string, siteName: string) => Promise<{ outcome: string; retryRunId: string | null }>;

let siteLostRunFinalizer: SiteLostRunFinalizer | null = null;

/** index.ts hands over the heartbeat service's finalizeSiteLostRun here (null clears it). */
export function registerSiteLostRunFinalizer(finalizer: SiteLostRunFinalizer | null): void {
  siteLostRunFinalizer = finalizer;
}

/** Starts the lanes when enabled; returns their stop function (a no-op when not enabled). */
export function startSiteHealth(db: Db, opts: { env?: NodeJS.ProcessEnv; clientManager: FleetClientManager }): () => void {
  const env = opts.env ?? process.env;
  if (!isSiteHealthEnabled(env)) return () => {};
  const finalizer = siteLostRunFinalizer;
  if (!finalizer) {
    logger.info("site-monitor lane not started: this process has no heartbeat service");
    return () => {};
  }

  const { clientManager } = opts;
  const store = siteHealthStore(db);
  const moves = createFleetMoveContext(db);
  const replicas = fleetReplicaStoreFromEnv(env);
  const keyOf = (site: MonitoredSite) => fleetSiteKey(site.companyId, site.name);

  const transportOf = (site: MonitoredSite) => {
    const transport = clientManager.getTransports?.().get(keyOf(site));
    // No client means the registry row cannot be turned into a connection (a secret that does not
    // resolve, say). That is a configuration fault, not a dead site: it must never count as a miss.
    if (!transport) throw new Error(`no client transport for site "${site.name}"`);
    return transport;
  };

  async function listSites(): Promise<MonitoredSite[]> {
    await clientManager.ensureFresh();
    return store.listSites();
  }

  const monitor = createSiteHealthMonitor({
    listSites,
    probe: (site) => probeSiteHealth(transportOf(site)),
    saveHealth: (siteId, health, lastSeenAt) => store.saveHealth(siteId, health, lastSeenAt),
    setStatus: (siteId, from, to) => store.setStatus(siteId, from, to),

    failover: (site) =>
      failoverSite(site.name, {
        listBots: () => store.listBotsOnSite(site.companyId, site.name),
        selectReserve: async () => FAILOVER_RESERVE_SITE,
        hasReplica: async (botKey) => Boolean(await replicas?.capturedAt(site.name, botKey)),
        async requeueRuns(botKey, companyId) {
          const runs = await db
            .select({ id: heartbeatRuns.id })
            .from(heartbeatRuns)
            .where(and(eq(heartbeatRuns.agentId, botKey), eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "running")));
          let requeued = 0;
          for (const run of runs) {
            const done = await finalizer(run.id, site.name);
            if (done.outcome === "finalized") requeued += 1;
          }
          return requeued;
        },
        async moveBot({ companyId, botKey, dstSite }) {
          try {
            const move = await moves.service.startMove({ companyId, botKey, dstSite, source: "replica" });
            return { ok: move.phase === "done", claimed: true };
          } catch (err) {
            if (err instanceof FleetMoveError && err.kind === "conflict") return { ok: false, claimed: false };
            throw err;
          }
        },
        async markUnavailable({ companyId, botKey, reason }) {
          logger.error(
            { site: site.name, companyId, botKey, reason },
            reason === "pinned"
              ? "pinned bot on a lost remote site: it is not moved"
              : "bot on a lost remote site cannot be moved: " + (reason === "no_replica" ? "no replica to restore" : "no reserve site"),
          );
        },
        log: logger,
      }),

    async reconcileReturned(site) {
      const botKeys = await store.listFailedOverBots(site.companyId, site.name);
      if (botKeys.length === 0) return;
      const key = keyOf(site);
      const driver = clientManager.getClients().get(key);
      if (!driver) throw new Error(`no driver for returned site "${site.name}"`);
      const agentClient = createSiteAgentClient(transportOf(site));
      const problems: string[] = [];
      for (const botKey of botKeys) {
        try {
          // Order of the return pass (remote-sites-v2 4.3): stop the old copy, then set its datadir aside.
          const status = await driver.status(botKey);
          if (status.state !== "missing" && status.state !== "stopped") await driver.stop(botKey);
          await agentClient.quarantine(botKey);
          logger.warn({ site: site.name, botKey }, "returned site: old copy of a failed-over bot stopped and set aside");
        } catch (err) {
          problems.push(`${botKey}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (problems.length > 0) throw new Error(`return pass incomplete: ${problems.join("; ")}`);
    },

    log: logger,
  });

  const timer = laneInterval(
    "bot_reconcile",
    SITE_HEALTH_MONITOR_INTERVAL_MS,
    () => monitor.tick(),
    (err) => logger.error({ err }, "site-monitor: sweep error"),
  );
  timer.unref?.();

  let stopReplicas: (() => void) | null = null;
  if (replicas) {
    stopReplicas = startFleetReplicaLane({
      listSites,
      listBots: (site) => store.listBotsOnSite(site.companyId, site.name),
      snapshot: (site, botKey) => createSiteAgentClient(transportOf(site)).snapshot(botKey),
      write: (siteName, botKey, stream) => replicas.write(siteName, botKey, stream),
      log: logger,
    }).stop;
  }

  logger.info({ replicas: Boolean(replicas) }, "site-monitor lane started");
  return () => {
    clearInterval(timer);
    stopReplicas?.();
    clearFleetSiteGauges();
  };
}
