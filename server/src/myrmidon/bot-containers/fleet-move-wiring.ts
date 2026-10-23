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
import { fleetMoveMaintenance } from "./fleet-move-maintenance.js";
import { createSiteAgentClient } from "./site-agent-client.js";
import { parseFleetHosts } from "./fleetd-hosts.js";
import { fleetdBotContainerDriver } from "./fleetd-driver.js";
import type { BotContainerDriver, BotContainerSpec } from "./driver.js";
import type { CompiledProfile } from "./types.js";
import { botContainerSpec, botKeyForAgent, readBotContainerAgentConfig } from "./agent-config.js";
import { botKeyLock } from "./bot-key-lock.js";
import { getBotContainerRuntime } from "./routes-wiring.js";
import type { BotContainerRuntimeDeps } from "./index.js";
import { agentService, secretService } from "../../services/index.js";
import { logger } from "../../middleware/logger.js";

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
}

export function createFleetMoveContext(db: Db): FleetMoveContext {
  const store = fleetMoveStore(db);
  const secrets = secretService(db);
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

  async function readSecretValue(companyId: string, name: string, what: string): Promise<string> {
    const secret = await secrets.getByName(companyId, name);
    if (!secret) throw new Error(`${what}: company secret "${name}" not found`);
    const value = (await secrets.resolveSecretValue(companyId, secret.id, "latest"))?.trim();
    if (!value) throw new Error(`${what}: company secret "${name}" is empty`);
    return value;
  }

  /** The fleetd address and token of a site, for the company that owns the bot. */
  async function resolveSiteHost(siteName: string, companyId: string): Promise<{ url: string; token: string }> {
    if (siteName === LOCAL_SITE) {
      const url = process.env[LOCAL_SITE_AGENT_URL_ENV]?.trim().replace(/\/+$/, "");
      const tokenSecret = process.env[LOCAL_SITE_AGENT_TOKEN_SECRET_ENV]?.trim();
      if (!url || !tokenSecret) {
        throw new Error(
          `site "${LOCAL_SITE}" has no site-agent configured: set ${LOCAL_SITE_AGENT_URL_ENV} and ${LOCAL_SITE_AGENT_TOKEN_SECRET_ENV}`,
        );
      }
      return { url, token: await readSecretValue(companyId, tokenSecret, `site "${LOCAL_SITE}"`) };
    }

    const envHost = parseFleetHosts(process.env.MYRMIDON_FLEET_HOSTS).get(siteName);
    if (envHost) {
      return { url: envHost.url, token: await readSecretValue(companyId, envHost.tokenSecret, `site "${siteName}"`) };
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
    if (row.status !== "active") {
      throw new Error(`site "${siteName}" is ${row.status}, not active`);
    }
    if (!row.tokenSecret) {
      throw new Error(`site "${siteName}" has no tokenSecret in the site registry`);
    }
    return { url: row.url, token: await readSecretValue(companyId, row.tokenSecret, `site "${siteName}"`) };
  }

  const service = new FleetMoveService({
    getMove: store.getMove,
    getLatestMoveForBot: store.getLatestMoveForBot,
    createMove: store.createMove,
    updateMove: store.updateMove,

    // A site name is resolved in the company that owns the move.
    async getDriverForSite(siteName: string, companyId: string): Promise<BotContainerDriver> {
      if (siteName === LOCAL_SITE) return requireRuntime().driver;
      const { url, token } = await resolveSiteHost(siteName, companyId);
      return fleetdBotContainerDriver({ baseUrl: url, token });
    },

    async getSiteAgentClient(siteName: string, companyId: string): Promise<SiteAgentClient> {
      const { url, token } = await resolveSiteHost(siteName, companyId);
      return createSiteAgentClient({ baseUrl: url, token });
    },

    async getSiteUrl(siteName: string, companyId: string): Promise<string> {
      const { url } = await resolveSiteHost(siteName, companyId);
      return url;
    },

    getAgentCard,
    updateAgentCard,

    async getBotSpec(botKey: string): Promise<BotContainerSpec> {
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
    },

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
  };
}

export function myrmidonFleetMoveRoutes(db: Db): Router {
  const ctx = createFleetMoveContext(db);
  return fleetMoveRoutes({ service: ctx.service, botCompanyId: ctx.botCompanyId });
}
