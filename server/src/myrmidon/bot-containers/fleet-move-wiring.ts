// server/src/myrmidon/bot-containers/fleet-move-wiring.ts
//
// myrmidon(1.6.6 REMOTE-SITES-T5): wiring for fleet bot move service and HTTP routes.

import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { agents, myrmidonFleetSites, type Db } from "@paperclipai/db";
import { fleetMoveStore } from "./fleet-move-store.js";
import { fleetMoveRoutes } from "./fleet-move-routes.js";
import { FleetMoveService, type SiteAgentClient } from "./fleet-move-service.js";
import { createSiteAgentClient } from "./site-agent-client.js";
import { parseFleetHosts } from "./fleetd-hosts.js";
import { fleetdBotContainerDriver } from "./fleetd-driver.js";
import type { BotContainerDriver, BotContainerSpec } from "./driver.js";
import type { CompiledProfile } from "./types.js";
import { secretService } from "../../services/secrets.js";
import { logger } from "../../middleware/logger.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function myrmidonFleetMoveRoutes(db: Db): Router {
  const store = fleetMoveStore(db);
  const secrets = secretService(db);

  async function resolveCompanyIdForBot(botKey: string): Promise<string | null> {
    const allAgents = await db.select().from(agents);
    for (const ag of allAgents) {
      const cfg = isRecord(ag.adapterConfig) ? ag.adapterConfig : {};
      const container = isRecord(cfg.container) ? cfg.container : {};
      if (container.botKey === botKey) {
        return ag.companyId;
      }
    }
    return null;
  }

  async function getAgentCard(botKey: string): Promise<{
    agentId: string;
    adapterConfig: Record<string, unknown>;
  } | null> {
    const allAgents = await db.select().from(agents);
    for (const ag of allAgents) {
      const cfg = isRecord(ag.adapterConfig) ? ag.adapterConfig : {};
      const container = isRecord(cfg.container) ? cfg.container : {};
      if (container.botKey === botKey) {
        return {
          agentId: ag.id,
          adapterConfig: cfg,
        };
      }
    }
    return null;
  }

  async function updateAgentCard(agentId: string, adapterConfig: Record<string, unknown>): Promise<void> {
    await db.update(agents).set({ adapterConfig, updatedAt: new Date() }).where(eq(agents.id, agentId));
  }

  // Resolve fleet host url and token
  async function resolveSiteHost(siteName: string): Promise<{ url: string; token: string }> {
    const hostsFromEnv = parseFleetHosts(process.env.MYRMIDON_FLEET_HOSTS);
    const envHost = hostsFromEnv.get(siteName);
    if (envHost) {
      return { url: envHost.url, token: "" };
    }

    // Check DB table myrmidon_fleet_sites
    const rows = await db
      .select()
      .from(myrmidonFleetSites)
      .where(eq(myrmidonFleetSites.name, siteName))
      .limit(1);

    if (rows[0]) {
      let token = "";
      if (rows[0].clientCertSecretKey) {
        try {
          const secret = await secrets.getByKey(rows[0].companyId, rows[0].clientCertSecretKey);
          if (secret) {
            token = (await secrets.resolveSecretValue(rows[0].companyId, secret.id, "latest")) ?? "";
          }
        } catch {
          token = "";
        }
      }
      return { url: rows[0].url, token };
    }

    return { url: `http://${siteName}:9100`, token: "" };
  }

  const service = new FleetMoveService({
    getMove: store.getMove,
    getLatestMoveForBot: store.getLatestMoveForBot,
    createMove: store.createMove,
    updateMove: store.updateMove,

    async getDriverForSite(siteName: string): Promise<BotContainerDriver> {
      const { url, token } = await resolveSiteHost(siteName);
      return fleetdBotContainerDriver({ baseUrl: url, token });
    },

    async getSiteAgentClient(siteName: string): Promise<SiteAgentClient> {
      const { url, token } = await resolveSiteHost(siteName);
      return createSiteAgentClient({ baseUrl: url, token });
    },

    async getSiteUrl(siteName: string): Promise<string> {
      const { url } = await resolveSiteHost(siteName);
      return url;
    },

    getAgentCard,
    updateAgentCard,

    async getBotSpec(botKey: string): Promise<BotContainerSpec> {
      const card = await getAgentCard(botKey);
      const container = isRecord(card?.adapterConfig.container) ? card!.adapterConfig.container : {};
      return {
        botKey,
        image: typeof container.image === "string" ? container.image : "ghcr.io/example/bot:latest",
        memoryMb: typeof container.memoryMb === "number" ? container.memoryMb : 1024,
        cpus: typeof container.cpus === "number" ? container.cpus : 1,
        pidsLimit: typeof container.pidsLimit === "number" ? container.pidsLimit : 256,
        network: "myrmidon-bots",
      };
    },

    async getCompiledProfile(botKey: string): Promise<CompiledProfile> {
      return {
        botKey,
        files: [],
        restartHash: "rh-live",
        filesHash: "fh-live",
      };
    },

    log: logger,
  });

  return fleetMoveRoutes({ service, resolveCompanyIdForBot });
}
