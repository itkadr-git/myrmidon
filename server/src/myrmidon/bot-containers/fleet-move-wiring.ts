// server/src/myrmidon/bot-containers/fleet-move-wiring.ts
//
// myrmidon(1.6.6 REMOTE-SITES-T5): wiring for the fleet bot move service and its HTTP routes.
//
// The bot key is the agent id (botKeyForAgent). Everything a move needs about the bot comes
// from the registered bot-container runtime (the same profile compiler, maintenance port and
// network the reconcile sweep uses) and from the agent's own card; nothing is made up. A site
// that cannot be resolved (not in MYRMIDON_FLEET_HOSTS, not in the company's site registry, no
// readable token) is an error, never a guessed address or a call without authorization.

import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { agents, myrmidonFleetSites, type Db } from "@myrmidon/db";
import { fleetMoveStore } from "./fleet-move-store.js";
import { fleetMoveRoutes } from "./fleet-move-routes.js";
import { FleetMoveService, type SiteAgentClient } from "./fleet-move-service.js";
import { siteStatusIsReachable } from "./site-health-flag.js";
import { fleetReplicaStoreFromEnv } from "./fleet-replica-store.js";
import { fleetMoveMaintenance } from "./fleet-move-maintenance.js";
import { createSiteAgentClient, type SiteAgentMemoryClient } from "./site-agent-client.js";
import { fleetMemorySyncFromEnv } from "./fleet-memory-sync-wiring.js";
import { forcedSyncBeforeMove } from "./fleet-memory-sync.js";
import { parseFleetHosts } from "./fleetd-hosts.js";
import { fleetdBotContainerDriver } from "./fleetd-driver.js";
import type { BotContainerDriver, BotContainerSpec } from "./driver.js";
import type { CompiledProfile } from "./types.js";
import { botContainerSpec, botKeyForAgent, readBotContainerAgentConfig } from "./agent-config.js";
import { botKeyLock } from "./bot-key-lock.js";
import { getBotContainerRuntime } from "./routes-wiring.js";
import type { BotContainerRuntimeDeps } from "./index.js";
import { agentService } from "../../services/index.js";
import { logger } from "../../middleware/logger.js";
import type { FleetClientManager, FleetSiteTransport } from "./site-registry.js";

/** The board's own site name: the local docker driver. Its site-agent is configured by env. */
export const LOCAL_SITE = "local";
export const LOCAL_SITE_AGENT_URL_ENV = "MYRMIDON_LOCAL_SITE_AGENT_URL";
export const LOCAL_SITE_AGENT_TOKEN_SECRET_ENV = "MYRMIDON_LOCAL_SITE_AGENT_TOKEN_SECRET";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface FleetMoveContext {
  service: FleetMoveService;
  /** The company that owns the bot (agent), or null when there is no such agent. */
  botCompanyId(botKey: string): Promise<string | null>;
  /** The container spec the bot's card asks for (limits, image): what the drift check compares with. */
  botSpec(botKey: string): Promise<BotContainerSpec>;
  /** The site-agent client of a site, for the company that owns the bot (site-agent calls outside the driver contract). */
  siteAgentClient(siteName: string, companyId: string): Promise<SiteAgentMemoryClient>;
}

export function createFleetMoveContext(db: Db, clientManager?: FleetClientManager | (() => FleetClientManager | null)): FleetMoveContext {
  const currentClientManager = () => typeof clientManager === "function" ? clientManager() ?? undefined : clientManager;
  const store = fleetMoveStore(db);
  const agentsApi = agentService(db);

  function requireRuntime(): BotContainerRuntimeDeps {
    const runtime = getBotContainerRuntime();
    if (!runtime) {
      throw new Error("bot container runtime is not running (MYRMIDON_BOT_CONTAINERS is off or the runtime could not be built)");
    }
    return runtime;
  }

  /** One agent by id (the bot key), read by primary key: never a scan of the table. */
  async function readAgentRow(botKey: string) {
    if (!UUID_PATTERN.test(botKey) || !botKeyForAgent(botKey)) return null;
    const rows = await db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        adapterType: agents.adapterType,
        adapterConfig: agents.adapterConfig,
      })
      .from(agents)
      .where(eq(agents.id, botKey))
      .limit(1);
    return rows[0] ?? null;
  }

  async function botCompanyId(botKey: string): Promise<string | null> {
    return (await readAgentRow(botKey))?.companyId ?? null;
  }

  async function getAgentCard(botKey: string) {
    const row = await readAgentRow(botKey);
    if (!row) return null;
    return {
      agentId: row.id,
      adapterConfig: isRecord(row.adapterConfig) ? row.adapterConfig : {},
    };
  }

  async function updateAgentCard(agentId: string, adapterConfig: Record<string, unknown>): Promise<void> {
    // The agent update path (as card sync does): the change is recorded as a config revision.
    await agentsApi.update(agentId, { adapterConfig }, { recordRevision: { source: "myrmidon_fleet_move" } });
  }


  /** The fleetd address and token of a site, for the company that owns the bot. */
  async function resolveSiteHost(siteName: string, companyId: string): Promise<FleetSiteTransport> {
    const manager = currentClientManager();
    if (manager) {
      await manager.ensureFresh();
      const transport = manager.getTransports?.().get(`${companyId}:${siteName}`);
      if (!transport || !transport.mtls || !transport.agent || !transport.caCert || !transport.clientCert || !transport.clientKey) {
        throw new Error(`site "${siteName}" has no valid mTLS client certificate, key, or CA`);
      }
      return transport;
    }
    if (siteName === LOCAL_SITE) {
      throw new Error(`site "${LOCAL_SITE}" requires a registered site mTLS client certificate, key, and CA`);
    }

    const envHost = parseFleetHosts(process.env.MYRMIDON_FLEET_HOSTS).get(siteName);
    if (envHost) {
      throw new Error(`site "${siteName}" uses token-only fleet host configuration; register it with a valid mTLS certificate, key, and CA`);
    }

    const rows = await db
      .select()
      .from(myrmidonFleetSites)
      .where(and(eq(myrmidonFleetSites.companyId, companyId), eq(myrmidonFleetSites.name, siteName)))
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw new Error(`site "${siteName}" is unknown: it is neither in MYRMIDON_FLEET_HOSTS nor in the site registry`);
    }
    // A draining site is still reachable for what happens on it (stopping or snapshotting the
    // bots that are being moved off); that it takes no new bots is the scheduler's rule.
    // Tied to MYRMIDON_SITE_HEALTH: without it only an active site is reachable, as before T4.
    if (!siteStatusIsReachable(row.status)) {
      throw new Error(`site "${siteName}" is ${row.status}, not active`);
    }
    throw new Error(`site "${siteName}" has no active mTLS client transport; register valid certificate, key, and CA`);
  }

  async function botSpec(botKey: string): Promise<BotContainerSpec> {
    const runtime = requireRuntime();
    const row = await readAgentRow(botKey);
    if (!row) throw new Error(`Bot "${botKey}" not found`);
    const parsed = readBotContainerAgentConfig(
      row.adapterType,
      isRecord(row.adapterConfig) ? row.adapterConfig : {},
      await runtime.readSharedMountSettings?.(),
      row.id,
    );
    if (!parsed.ok) throw new Error(`Bot "${botKey}" has no usable container card: ${parsed.reason}`);
    return botContainerSpec(botKey, parsed.config, runtime.network);
  }

  // myrmidon(1.6.6 C-MEM): the memory sync right before a live move; null when not configured.
  const memorySync = fleetMemorySyncFromEnv(db, process.env, async (site, botKey) => {
    const transport = await resolveSiteHost(site.name, site.companyId);
    return createSiteAgentClient({ baseUrl: transport.baseUrl, token: transport.token, agent: transport.agent, requireMtls: true }).memoryExport(botKey);
  });

  const service = new FleetMoveService({
    async beforeSnapshot({ moveId, companyId, botKey, srcSite }) {
      if (!memorySync || srcSite === LOCAL_SITE) return;
      await forcedSyncBeforeMove(memorySync, { companyId, siteName: srcSite, botKey, moveId }, { log: logger });
    },

    getMove: store.getMove,
    getLatestMoveForBot: store.getLatestMoveForBot,
    createMove: store.createMove,
    updateMove: store.updateMove,

    // A site name is resolved in the company that owns the move.
    async getDriverForSite(siteName: string, companyId: string): Promise<BotContainerDriver> {
      if (siteName === LOCAL_SITE) return requireRuntime().driver;
      const transport = await resolveSiteHost(siteName, companyId);
      return fleetdBotContainerDriver({ baseUrl: transport.baseUrl, token: transport.token, caCert: transport.caCert, clientCert: transport.clientCert, clientKey: transport.clientKey, httpsAgent: transport.agent });
    },

    async getSiteAgentClient(siteName: string, companyId: string): Promise<SiteAgentClient> {
      const transport = await resolveSiteHost(siteName, companyId);
      return createSiteAgentClient({ baseUrl: transport.baseUrl, token: transport.token, agent: transport.agent, requireMtls: true });
    },


    async getSiteUrl(siteName: string, companyId: string): Promise<string> {
      return (await resolveSiteHost(siteName, companyId)).baseUrl;
    },

    // myrmidon(1.6.6 REMOTE-SITES-T4): the replicas the board keeps of remote datadirs, when
    // MYRMIDON_FLEET_REPLICA_DIR names the store. Without it a replica move has nothing to open.
    async openReplica(site: string, botKey: string) {
      return (await fleetReplicaStoreFromEnv()?.open(site, botKey)) ?? null;
    },

    getAgentCard,
    updateAgentCard,

    getBotSpec: botSpec,

    async getCompiledProfile(botKey: string): Promise<CompiledProfile> {
      // The profile is compiled from the card as it is now (the card already names the destination).
      return requireRuntime().compile(botKey, botKey);
    },

    maintenance: {
      enter: (botKey) => fleetMoveMaintenance(requireRuntime().maintenance).enter(botKey),
      exit: (botKey) => fleetMoveMaintenance(requireRuntime().maintenance).exit(botKey),
    },
    lock: botKeyLock,

    log: logger,
  });

  return {
    service,
    botCompanyId,
    botSpec,
    async siteAgentClient(siteName: string, companyId: string) {
      const transport = await resolveSiteHost(siteName, companyId);
      return createSiteAgentClient({ baseUrl: transport.baseUrl, token: transport.token, agent: transport.agent, requireMtls: true });
    },
  };
}

export function myrmidonFleetMoveRoutes(db: Db, clientManager?: FleetClientManager | (() => FleetClientManager | null)): Router {
  const ctx = createFleetMoveContext(db, clientManager);
  return fleetMoveRoutes({ service: ctx.service, botCompanyId: ctx.botCompanyId, getSiteLogs: (site, companyId, botKey, tail) => ctx.siteAgentClient(site, companyId).then((client) => client.logs(botKey, tail)) });
}
