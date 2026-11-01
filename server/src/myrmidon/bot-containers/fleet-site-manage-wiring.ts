// server/src/myrmidon/bot-containers/fleet-site-manage-wiring.ts
//
// myrmidon(1.6.6 REMOTE-SITES-T8): binds the fleet screen's routes to the registry, the bot cards and
// the routed container driver. Reads are bounded: a site that does not answer within a few seconds
// shows as "unknown" on the screen, it never holds the page.

import { Router } from "express";
import { and, eq, sql } from "drizzle-orm";
import { agents, myrmidonFleetSites, type Db } from "@myrmidon/db";
import { logger } from "../../middleware/logger.js";
import { HERMES_GATEWAY_ADAPTER_TYPE } from "./agents-query.js";
import { BOT_CONTAINER_DEFAULTS } from "./agent-config.js";
import { createFleetMoveContext } from "./fleet-move-wiring.js";
import { createSiteAgentClient } from "./site-agent-client.js";
import { fleetSiteManageRoutes, type BotCardView, type SiteBotView, type SiteLoad } from "./fleet-site-manage-routes.js";
import { getBotContainerRuntime } from "./routes-wiring.js";
import { siteHealthStore } from "./site-health-store.js";
import { getFleetSite, listFleetSites, parseTlsCredentials, updateFleetSite, type FleetClientManager } from "./site-registry.js";
import { X509Certificate } from "node:crypto";
import { secretService } from "../../services/index.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How long one bot's answer from its site is waited for on the screen. */
const SITE_CALL_TIMEOUT_MS = 4_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function myrmidonFleetSiteManageRoutes(db: Db, clientManager?: FleetClientManager | (() => FleetClientManager | null)): Router {
  const moves = createFleetMoveContext(db, clientManager);
  const currentClientManager = () => typeof clientManager === "function" ? clientManager() ?? undefined : clientManager;
  const health = siteHealthStore(db);
  const secrets = secretService(db);

  async function registeredTransport(companyId: string, siteName: string) {
    const manager = currentClientManager();
    if (!manager) throw new Error(`site "${siteName}" has no active mTLS client transport`);
    await manager.ensureFresh();
    const transport = manager.getTransports?.()?.get(`${companyId}:${siteName}`);
    if (!transport?.mtls || !transport.agent || !transport.caCert || !transport.clientCert || !transport.clientKey) {
      throw new Error(`site "${siteName}" has no valid mTLS client certificate, key, or CA`);
    }
    return transport;
  }

  /** The enabled container bots whose card puts them on `siteName`. */
  async function cardsOnSite(companyId: string, siteName: string) {
    const rows = await db
      .select({ id: agents.id, name: agents.name, adapterConfig: agents.adapterConfig })
      .from(agents)
      .where(
        and(
          eq(agents.companyId, companyId),
          eq(agents.adapterType, HERMES_GATEWAY_ADAPTER_TYPE),
          sql`${agents.status} <> 'terminated'`,
          sql`${agents.adapterConfig} #>> '{container,enabled}' = 'true'`,
          sql`${agents.adapterConfig} #>> '{container,host}' = ${siteName}`,
        ),
      );
    return rows.map((row) => {
      const config = isRecord(row.adapterConfig) ? row.adapterConfig : {};
      const container = isRecord(config.container) ? config.container : {};
      return { id: row.id, name: row.name, config, container };
    });
  }

  async function driftOf(botKey: string): Promise<{ state: string; image: string | null; gatewayPort: number | null; fields: string[] }> {
    const runtime = getBotContainerRuntime();
    if (!runtime) throw new Error("bot container runtime is not running");
    const status = await runtime.driver.status(botKey);
    if (status.state === "missing") return { state: status.state, image: status.image ?? null, gatewayPort: null, fields: [] };
    const spec = await moves.botSpec(botKey);
    const report = await runtime.driver.templateDrift(spec, status);
    return {
      state: status.state,
      image: status.image ?? null,
      gatewayPort: status.gatewayPort ?? null,
      fields: report.drifted ? report.fields.map((field) => field.field) : [],
    };
  }

  return fleetSiteManageRoutes({
    listSites: (companyId) => listFleetSites(db, companyId),
    getSite: (companyId, name) => getFleetSite(db, companyId, name),
    updateSite: (companyId, name, patch) => updateFleetSite(db, companyId, name, patch),
    setStatus: (siteId, from, to) => health.setStatus(siteId, from, to),

    // The secret is the source of truth for the key's lifetime (same lookup order as the client manager).
    async readClientCertNotAfter(site) {
      const ref = site.clientCertSecretKey;
      if (!ref) return null;
      for (const name of [ref, `${ref}-cert`, `${ref}_cert`]) {
        const secret = await secrets.getByName(site.companyId, name);
        if (!secret) continue;
        const raw = await secrets.resolveSecretValue(site.companyId, secret.id, "latest");
        const cert = raw ? parseTlsCredentials(raw).cert : undefined;
        if (!cert) continue;
        const end = new Date(new X509Certificate(cert).validTo);
        return Number.isNaN(end.getTime()) ? null : end;
      }
      return null;
    },
    async storeClientCertNotAfter(site, notAfter) {
      await updateFleetSite(db, site.companyId, site.name, { clientCertNotAfter: notAfter });
    },

    async markOperatorState(siteId) {
      await db
        .update(myrmidonFleetSites)
        .set({ health: sql`jsonb_set(${myrmidonFleetSites.health}, '{autoDrained}', 'false'::jsonb)`, updatedAt: new Date() })
        .where(and(eq(myrmidonFleetSites.id, siteId), sql`${myrmidonFleetSites.health} is not null`));
    },

    async siteLoad(companyId, siteName): Promise<SiteLoad> {
      const cards = await cardsOnSite(companyId, siteName);
      let cpus = 0;
      let memoryMb = 0;
      for (const card of cards) {
        cpus += positive(card.container.cpus, BOT_CONTAINER_DEFAULTS.cpus);
        memoryMb += positive(card.container.memoryMb, BOT_CONTAINER_DEFAULTS.memoryMb);
      }
      let driftCount: number | null = null;
      if (getBotContainerRuntime() && cards.length > 0) {
        const results = await Promise.allSettled(
          cards.map((card) => withTimeout(driftOf(card.id), SITE_CALL_TIMEOUT_MS, `status of ${card.id}`)),
        );
        driftCount = results.some((r) => r.status === "rejected")
          ? null
          : results.filter((r) => r.status === "fulfilled" && r.value.fields.length > 0).length;
      } else if (cards.length === 0) {
        driftCount = 0;
      }
      return { bots: cards.length, cpus, memoryMb, driftCount };
    },

    async listSiteBots(companyId, siteName): Promise<SiteBotView[]> {
      const cards = await cardsOnSite(companyId, siteName);
      const views = await Promise.all(
        cards.map(async (card): Promise<SiteBotView> => {
          const apiBaseUrl = typeof card.config.apiBaseUrl === "string" ? card.config.apiBaseUrl : null;
          const base = {
            botKey: card.id,
            agentName: card.name,
            apiBaseUrl,
            pinned: card.container.hostPinned === true,
          };
          try {
            const live = await withTimeout(driftOf(card.id), SITE_CALL_TIMEOUT_MS, `status of ${card.id}`);
            return {
              ...base,
              state: live.state,
              image: live.image,
              drift: live.fields.length > 0,
              driftFields: live.fields,
              gatewayPort: live.gatewayPort,
            };
          } catch {
            return { ...base, state: "unknown", image: null, drift: false, driftFields: [], gatewayPort: null };
          }
        }),
      );
      return views.sort((a, b) => a.agentName.localeCompare(b.agentName));
    },

    async botCard(botKey): Promise<BotCardView | null> {
      if (!UUID_PATTERN.test(botKey)) return null;
      const rows = await db
        .select({ companyId: agents.companyId, adapterConfig: agents.adapterConfig })
        .from(agents)
        .where(eq(agents.id, botKey))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      const config = isRecord(row.adapterConfig) ? row.adapterConfig : {};
      const container = isRecord(config.container) ? config.container : {};
      const host = typeof container.host === "string" && container.host.trim() ? container.host.trim() : null;
      return { companyId: row.companyId, host };
    },

    async actOnBot(botKey, action) {
      const card = await db.select({ companyId: agents.companyId, adapterConfig: agents.adapterConfig }).from(agents).where(eq(agents.id, botKey)).limit(1);
      const config = isRecord(card[0]?.adapterConfig) ? card[0].adapterConfig : {};
      const container = isRecord(config.container) ? config.container : {};
      const siteName = typeof container.host === "string" ? container.host : "";
      if (!siteName || !card[0]) throw new Error(`Bot "${botKey}" has no registered remote site`);
      const manager = currentClientManager();
      if (!manager) throw new Error(`site "${siteName}" has no active mTLS client transport`);
      await manager.ensureFresh();
      const transport = manager.getTransports?.()?.get(`${card[0].companyId}:${siteName}`);
      if (!transport?.mtls || !transport.agent || !transport.caCert || !transport.clientCert || !transport.clientKey) {
        throw new Error(`site "${siteName}" has no valid mTLS client certificate, key, or CA`);
      }
      const driver = manager.getClients().get(`${card[0].companyId}:${siteName}`);
      if (!driver) throw new Error(`site "${siteName}" has no active mTLS client transport`);
      if (action === "restart") await driver.restart(botKey);
      else await driver.stop(botKey);
    },

    async botLogs(companyId, siteName, botKey, tail = 100) {
      const transport = await registeredTransport(companyId, siteName);
      return createSiteAgentClient({ baseUrl: transport.baseUrl, token: transport.token, agent: transport.agent, requireMtls: true }).logs(botKey, tail);
    },

    log: logger,
  });
}
