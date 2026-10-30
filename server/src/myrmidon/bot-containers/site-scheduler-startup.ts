// server/src/myrmidon/bot-containers/site-scheduler-startup.ts
//
// myrmidon(1.6.6 REMOTE-SITES-T5): startup wiring of the site-scheduler lane (30 s).
//
// The lane moves bots between sites, so it is opt-in: it starts only with MYRMIDON_BOT_CONTAINERS on
// AND MYRMIDON_SITE_SCHEDULER=1 (nothing is read or scheduled otherwise). MYRMIDON_SITE_SCHEDULER_PREEMPTION=1
// additionally lets a critical bot push a low-priority one out of a full affinity site.
//
// Data it reads: the company's rows in myrmidon_fleet_sites (the site registry) and
// myrmidon_fleet_affinity (which agents, projects or companies prefer which site), and the bot cards.

import { and, eq, ne, sql } from "drizzle-orm";
import { agents, myrmidonFleetAffinity, myrmidonFleetSites, type Db } from "@myrmidon/db";
import { agentService } from "../../services/index.js";
import { logger } from "../../middleware/logger.js";
import { isBotContainersEnabled } from "./agent-config.js";
import { HERMES_GATEWAY_ADAPTER_TYPE } from "./agents-query.js";
import { createFleetMoveContext } from "./fleet-move-wiring.js";
import { startSiteSchedulerLane, type ScheduledAgentCard } from "./site-scheduler-lane.js";
import type { AffinityRule, FleetSiteInfo } from "./site-scheduler.js";

export const SITE_SCHEDULER_ENV = "MYRMIDON_SITE_SCHEDULER";
export const SITE_SCHEDULER_PREEMPTION_ENV = "MYRMIDON_SITE_SCHEDULER_PREEMPTION";

const SITE_STATUSES = ["active", "draining", "quarantined", "disabled"] as const;
const AFFINITY_SCOPES = ["project", "company", "agent"] as const;

export function isSiteSchedulerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isBotContainersEnabled(env) && env[SITE_SCHEDULER_ENV]?.trim() === "1";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Starts the lane when enabled; returns its stop function (a no-op when not enabled). */
export function startSiteScheduler(db: Db, opts: { env?: NodeJS.ProcessEnv } = {}): () => void {
  const env = opts.env ?? process.env;
  if (!isSiteSchedulerEnabled(env)) return () => {};

  const moves = createFleetMoveContext(db);
  const agentsApi = agentService(db);

  const lane = startSiteSchedulerLane({
    async listAgents(): Promise<ScheduledAgentCard[]> {
      // Only the container block is listed (as the reconcile sweep does); saving goes through saveContainerConfig.
      const rows = await db
        .select({
          id: agents.id,
          companyId: agents.companyId,
          container: sql<unknown>`${agents.adapterConfig} -> 'container'`.mapWith(agents.adapterConfig),
        })
        .from(agents)
        .where(
          and(
            eq(agents.adapterType, HERMES_GATEWAY_ADAPTER_TYPE),
            ne(agents.status, "terminated"),
            sql`${agents.adapterConfig} #> '{container,enabled}' = 'true'::jsonb`,
          ),
        );
      return rows.map((row) => ({ id: row.id, companyId: row.companyId, adapterConfig: { container: row.container } }));
    },

    async listSites(companyId: string): Promise<FleetSiteInfo[]> {
      const rows = await db.select().from(myrmidonFleetSites).where(eq(myrmidonFleetSites.companyId, companyId));
      return rows.map((row) => ({
        name: row.name,
        status: (SITE_STATUSES as readonly string[]).includes(row.status) ? (row.status as FleetSiteInfo["status"]) : "disabled",
        capacity: row.capacity,
        labels: row.labels ?? undefined,
      }));
    },

    async listAffinityRules(companyId: string): Promise<AffinityRule[]> {
      const rows = await db.select().from(myrmidonFleetAffinity).where(eq(myrmidonFleetAffinity.companyId, companyId));
      return rows
        .filter((row) => (AFFINITY_SCOPES as readonly string[]).includes(row.scope))
        .map((row) => ({
          scope: row.scope as AffinityRule["scope"],
          targetId: row.targetId,
          siteName: row.siteName,
          weight: row.weight,
        }));
    },

    requestMove: (params) => moves.service.startMove(params),
    getLatestMove: (companyId, botKey) => moves.service.getLatestMove(companyId, botKey),

    async saveContainerConfig(agentId: string, container: Record<string, unknown>): Promise<void> {
      // The card as it is now, with only its container block replaced.
      const rows = await db.select({ adapterConfig: agents.adapterConfig }).from(agents).where(eq(agents.id, agentId)).limit(1);
      const current = rows[0];
      if (!current) return;
      const adapterConfig = isRecord(current.adapterConfig) ? current.adapterConfig : {};
      await agentsApi.update(
        agentId,
        { adapterConfig: { ...adapterConfig, container } },
        { recordRevision: { source: "myrmidon_site_scheduler" } },
      );
    },

    log: logger,
    preemptionEnabled: env[SITE_SCHEDULER_PREEMPTION_ENV]?.trim() === "1",
  });

  logger.info("site-scheduler lane started");
  return lane.stop;
}
