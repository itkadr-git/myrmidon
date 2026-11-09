// server/src/myrmidon/bot-containers/site-health-store.ts
//
// myrmidon(1.6.6 REMOTE-SITES-T4): the Drizzle side of the site health monitor: which sites it
// watches, where it keeps their health, the status changes it makes (compare-and-swap on the
// current status) and which bots sit on a site.

import { and, eq, inArray, sql } from "drizzle-orm";
import { agents, myrmidonFleetMoves, myrmidonFleetSites, type Db, type FleetSiteHealth } from "@myrmidon/db";
import { HERMES_GATEWAY_ADAPTER_TYPE } from "./agents-query.js";
import { bumpFleetRegistryVersion } from "./site-registry.js";

export type SiteStatus = "active" | "draining" | "quarantined" | "disabled";

export interface MonitoredSite {
  id: string;
  companyId: string;
  name: string;
  url: string;
  status: string;
  labels: Record<string, string>;
  health: FleetSiteHealth | null;
}

export interface SiteBot {
  companyId: string;
  botKey: string;
  site: string;
  pinned: boolean;
}

export interface SiteHealthStore {
  /** Sites the monitor watches: active and draining (a quarantined or disabled site is not probed). */
  listSites(): Promise<MonitoredSite[]>;
  saveHealth(siteId: string, health: FleetSiteHealth, lastSeenAt: Date | null): Promise<void>;
  /** Changes the status only when it is still one of `from`; false when another writer got there first. */
  setStatus(siteId: string, from: readonly string[], to: SiteStatus): Promise<boolean>;
  /** Bots whose card names `site` as their host. */
  listBotsOnSite(companyId: string, site: string): Promise<SiteBot[]>;
  /** Bots of the company with a move that is not done or failed. */
  listBotsWithOpenMove(companyId: string): Promise<string[]>;
  /** Bots that a replica failover moved off `site` and whose old copy may start again there. */
  listFailedOverBots(companyId: string, site: string): Promise<string[]>;
}

export function siteHealthStore(db: Db): SiteHealthStore {
  return {
    async listSites() {
      const rows = await db
        .select()
        .from(myrmidonFleetSites)
        .where(inArray(myrmidonFleetSites.status, ["active", "draining"]));
      return rows.map((row) => ({
        id: row.id,
        companyId: row.companyId,
        name: row.name,
        url: row.url,
        status: row.status,
        labels: row.labels ?? {},
        health: row.health ?? null,
      }));
    },

    async saveHealth(siteId, health, lastSeenAt) {
      await db
        .update(myrmidonFleetSites)
        .set({ health, ...(lastSeenAt ? { lastSeenAt } : {}), updatedAt: new Date() })
        .where(eq(myrmidonFleetSites.id, siteId));
    },

    async setStatus(siteId, from, to) {
      const changed = await db
        .update(myrmidonFleetSites)
        .set({ status: to, updatedAt: new Date() })
        .where(and(eq(myrmidonFleetSites.id, siteId), inArray(myrmidonFleetSites.status, [...from])))
        .returning({ id: myrmidonFleetSites.id });
      if (changed.length > 0) bumpFleetRegistryVersion();
      return changed.length > 0;
    },

    async listBotsOnSite(companyId, site) {
      const rows = await db
        .select({
          id: agents.id,
          pinned: sql<boolean>`coalesce((${agents.adapterConfig} #>> '{container,hostPinned}')::boolean, false)`,
        })
        .from(agents)
        .where(
          and(
            eq(agents.companyId, companyId),
            eq(agents.adapterType, HERMES_GATEWAY_ADAPTER_TYPE),
            sql`${agents.status} <> 'terminated'`,
            sql`${agents.adapterConfig} #>> '{container,enabled}' = 'true'`,
            sql`${agents.adapterConfig} #>> '{container,host}' = ${site}`,
          ),
        );
      return rows.map((row) => ({ companyId, botKey: row.id, site, pinned: row.pinned === true }));
    },

    async listBotsWithOpenMove(companyId) {
      const rows = await db
        .select({ botKey: myrmidonFleetMoves.botKey })
        .from(myrmidonFleetMoves)
        .where(and(eq(myrmidonFleetMoves.companyId, companyId), sql`${myrmidonFleetMoves.phase} NOT IN ('done', 'failed')`));
      return rows.map((row) => row.botKey);
    },

    async listFailedOverBots(companyId, site) {
      const rows = await db
        .select({ botKey: myrmidonFleetMoves.botKey })
        .from(myrmidonFleetMoves)
        .where(
          and(
            eq(myrmidonFleetMoves.companyId, companyId),
            eq(myrmidonFleetMoves.srcSite, site),
            eq(myrmidonFleetMoves.source, "replica"),
            eq(myrmidonFleetMoves.phase, "done"),
          ),
        );
      const keys = [...new Set(rows.map((row) => row.botKey))];
      if (keys.length === 0) return [];
      // Only a bot that is not on the site now: one that was moved back on purpose is not foreign.
      const stillThere = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(inArray(agents.id, keys), sql`${agents.adapterConfig} #>> '{container,host}' = ${site}`));
      const there = new Set(stillThere.map((row) => row.id));
      return keys.filter((key) => !there.has(key));
    },
  };
}
