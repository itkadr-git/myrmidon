// server/src/myrmidon/bot-containers/routes-wiring.ts
//
// myrmidon(W2b): real wiring of routes.ts (database lookup, permission check) and
// the registry the container runtime is plugged into.
//
// The runtime (driver, profile compiler, maintenance port, network) is not built
// here: compiling a profile needs the agent's resolved env, secrets and skills,
// and that belongs to the startup wiring (startup.ts, W2a), which calls
// setBotContainerRuntime once at startup, with the same runtime the periodic
// sweep uses. Until then (flag off, no scheduler in this process, or a runtime
// that could not be built) the routes answer "runtime not configured" instead
// of guessing.

import { and, desc, eq, gte } from "drizzle-orm";
import { agents, heartbeatRuns, knowledgeDeliveries, type Db } from "@paperclipai/db";
import { forbidden } from "../../errors.js";
import { accessService } from "../../services/index.js";
import { authorizationDeniedDetails } from "../../services/authorization.js";
import { applyBotContainerNow, type BotContainerAgent, type BotContainerRuntimeDeps } from "./index.js";
import { GATEWAY_RATE_LIMITED_ERROR_CODE } from "./concurrency-sync.js";
import { botContainerRoutes } from "./routes.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let registeredRuntime: BotContainerRuntimeDeps | null = null;

export function setBotContainerRuntime(runtime: BotContainerRuntimeDeps | null): void {
  registeredRuntime = runtime;
}

export function getBotContainerRuntime(): BotContainerRuntimeDeps | null {
  return registeredRuntime;
}

/**
 * The runtime's fresh-card read (index.ts `BotContainerRuntimeDeps.readAgent`)
 * over the database: the same row the card's status/apply read, in the shape a
 * reconcile pass takes. Every pass re-reads its own agent under the per-bot
 * lock, so the sweep's once-per-tick snapshot is never the template that gets
 * applied.
 */
export function botContainerAgentReader(db: Db): (agentId: string) => Promise<BotContainerAgent | null> {
  return async (agentId) => {
    // A malformed id is "no such agent", not a database error (as in getAgent).
    if (!UUID_PATTERN.test(agentId)) return null;
    const row = await db
      .select({
        agentId: agents.id,
        adapterType: agents.adapterType,
        adapterConfig: agents.adapterConfig,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    return row;
  };
}

/** Router for app.ts: the agent card's container status and "Apply now". */
export function myrmidonBotContainerRoutes(db: Db) {
  // Built on first use: app.ts is constructed in tests that stub parts of services/.
  let access: ReturnType<typeof accessService> | null = null;
  return botContainerRoutes({
    getAgent: async (id) => {
      // A malformed id is "no such agent", not a database error.
      if (!UUID_PATTERN.test(id)) return null;
      const row = await db
        .select({
          id: agents.id,
          companyId: agents.companyId,
          adapterType: agents.adapterType,
          adapterConfig: agents.adapterConfig,
          // myrmidon(CONCURRENCY-SYNC): the card's heartbeat.maxConcurrentRuns, so the
          // status route can report the limit the board would apply.
          runtimeConfig: agents.runtimeConfig,
          // myrmidon(BOT-ROLLOUT): the agent's lifecycle status, the same value the
          // rollout script reads to decide a switch (idle/pause only).
          status: agents.status,
        })
        .from(agents)
        .where(eq(agents.id, id))
        .then((rows) => rows[0] ?? null);
      return row;
    },
    /**
     * myrmidon(CONCURRENCY-SYNC): the newest run of this agent the hermes gateway
     * refused with 429, inside the lookback window. Only asked for an agent whose
     * gateway the board does not manage (see routes.ts): for a container of its own
     * the board has the applied value and does not need to infer anything.
     */
    recentGatewayRateLimit: async (agent, { sinceIso }) => {
      const row = await db
        .select({ createdAt: heartbeatRuns.createdAt })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.agentId, agent.id),
            eq(heartbeatRuns.errorCode, GATEWAY_RATE_LIMITED_ERROR_CODE),
            gte(heartbeatRuns.createdAt, new Date(sinceIso)),
          ),
        )
        .orderBy(desc(heartbeatRuns.createdAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      return row ? row.createdAt.toISOString() : null;
    },
    /**
     * myrmidon(1.7 KNOWLEDGE-2.0 L-3): the agent's knowledge delivery ledger row
     * (knowledge_deliveries), written by the profile compiler on each compile.
     * The ledger carries no caste/file/rules columns — they are folded into the
     * bundle-hash string the compiler records; the block only needs the slugs,
     * the rule count and the compile time, so the hash part is not echoed here.
     */
    readKnowledgeDelivery: async (agentId) => {
      const [row] = await db
        .select({
          indexItemIds: knowledgeDeliveries.indexItemIds,
          rulesRevisionIds: knowledgeDeliveries.rulesRevisionIds,
          bundleHash: knowledgeDeliveries.bundleHash,
          compiledAt: knowledgeDeliveries.compiledAt,
        })
        .from(knowledgeDeliveries)
        .where(eq(knowledgeDeliveries.agentId, agentId))
        .limit(1);
      if (!row) return null;
      // The bundle hash is "file|caste|slugs|rulesCount" (profile-ports.ts); the
      // slugs/rulesCount are re-derived from their own columns, so the parse is
      // limited to the caste part (field 2), tolerating an older format.
      const parts = row.bundleHash.split("|");
      const caste = parts.length === 4 && parts[1] !== "-" ? parts[1] : null;
      const rulesCount = row.rulesRevisionIds.length;
      return {
        caste,
        file: parts[0] ?? null,
        indexSlugs: row.indexItemIds,
        rulesCount,
        compiledAt: row.compiledAt.toISOString(),
      };
    },
    assertCanUpdateAgent: async (req, agent) => {
      access ??= accessService(db);
      const decision = await access.decide({
        actor: req.actor,
        action: "agent_config:update",
        resource: { type: "agent", companyId: agent.companyId, agentId: agent.id },
      });
      if (!decision.allowed) throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
    },
    getRuntime: getBotContainerRuntime,
    applyNow: applyBotContainerNow,
  });
}