// server/src/myrmidon/bot-containers/agents-query.ts
//
// myrmidon(W2a): the agents-table query behind the periodic reconciliation sweep
// (startup.ts hands it to startBotContainerReconciliation as `listAgents`).
//
// The filter runs in the database: only `hermes_gateway` agents whose card has
// `adapterConfig.container.enabled` set to true, and never a terminated one.
// (The board hard-deletes an agent row; there is no soft-delete column, so a
// deleted agent is simply absent.) The sweep runs once a minute, so the query
// reads only the `container` sub-object of the card, not the whole adapterConfig
// (which can carry a long instructions text and env bindings): reconcile needs
// nothing else, and everything else about the bot is read by the profile
// compiler by agent id. `container.enabled` is compared as the jsonb value `true`
// (not as extracted text, which would also match the string "true"), so a string
// or a number does not qualify, exactly like readBotContainerAgentConfig, which
// the sweep applies to each row afterwards.

import { agentConfigRevisions, agents, heartbeatRuns, type Db } from "@myrmidon/db";
import { and, desc, eq, ne, or, sql } from "drizzle-orm";
import type { BotDecommissionCandidate } from "./bot-decommission.js";
import type { BotContainerAgent } from "./index.js";
import type { BotContainerRouteAgent } from "./routes.js";

export const HERMES_GATEWAY_ADAPTER_TYPE = "hermes_gateway";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Agents the sweep reconciles; see the module comment. */
export function listBotContainerAgents(db: Db): () => Promise<BotContainerAgent[]> {
  return async () => {
    const rows = await db
      .select({
        agentId: agents.id,
        adapterType: agents.adapterType,
        // jsonb `->`; decoded through the column's own decoder, which parses the
        // text form some drivers return for a jsonb expression.
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
    return rows.map((row) => ({
      agentId: row.agentId,
      adapterType: row.adapterType,
      adapterConfig: { container: row.container },
    }));
  };
}

/**
 * myrmidon(OPE-12654): the decommission candidates (bot-decommission.ts) — agents whose bot
 * container may have outlived their place in the runtime:
 *  - terminated, or on another adapter than hermes_gateway (the sweep's own listing above
 *    excludes exactly these), AND
 *  - container mode on: the card still says `container.enabled: true`, or a config revision
 *    recorded it on a hermes_gateway card before a change. An adapter switch rewrites the card
 *    without the container block (10.11: the omp_local card kept nothing of it), so the history
 *    is the only place that still knows the agent had a bot.
 * The history check is one hashed pass over the revisions table, run once per decommission
 * sweep (every 10 minutes, not every tick). Ids only: the sweep asks the driver whether a
 * container is still there.
 */
export function listBotDecommissionCandidates(db: Db): () => Promise<BotDecommissionCandidate[]> {
  return async () => {
    const cardEnabled = sql`${agents.adapterConfig} #> '{container,enabled}' = 'true'::jsonb`;
    const historyEnabled = sql`exists (
      select 1 from ${agentConfigRevisions}
      where ${agentConfigRevisions.agentId} = ${agents.id}
        and ${agentConfigRevisions.beforeConfig} ->> 'adapterType' = ${HERMES_GATEWAY_ADAPTER_TYPE}
        and ${agentConfigRevisions.beforeConfig} #> '{adapterConfig,container,enabled}' = 'true'::jsonb
    )`;
    const rows = await db
      .select({
        agentId: agents.id,
        companyId: agents.companyId,
        adapterType: agents.adapterType,
        status: agents.status,
      })
      .from(agents)
      .where(
        and(
          or(eq(agents.status, "terminated"), ne(agents.adapterType, HERMES_GATEWAY_ADAPTER_TYPE)),
          or(cardEnabled, historyEnabled),
        ),
      )
      .orderBy(agents.id);
    return rows.map((row) => ({ agentId: row.agentId, companyId: row.companyId, adapterType: row.adapterType, status: row.status }));
  };
}

/**
 * myrmidon(OPE-12654): the container block of the agent's last hermes_gateway card, from its
 * config history, or null. The routing driver (fleetd-routing.ts) reads the bot's host off the
 * card; a card that moved to another adapter lost the block, and its bot still lives on the host
 * the last hermes card named, which is where its decommission has to go.
 */
export function lastBotContainerBlock(db: Db): (agentId: string) => Promise<unknown> {
  return async (agentId) => {
    if (!UUID_PATTERN.test(agentId)) return null;
    const rows = await db
      .select({
        // Decoded through the column's own decoder, as in listBotContainerAgents.
        container: sql<unknown>`${agentConfigRevisions.beforeConfig} #> '{adapterConfig,container}'`.mapWith(agentConfigRevisions.beforeConfig),
      })
      .from(agentConfigRevisions)
      .where(
        and(
          eq(agentConfigRevisions.agentId, agentId),
          sql`${agentConfigRevisions.beforeConfig} ->> 'adapterType' = ${HERMES_GATEWAY_ADAPTER_TYPE}`,
          sql`jsonb_typeof(${agentConfigRevisions.beforeConfig} #> '{adapterConfig,container}') = 'object'`,
        ),
      )
      .orderBy(desc(agentConfigRevisions.createdAt))
      .limit(1);
    return rows[0]?.container ?? null;
  };
}

/** myrmidon(OPE-12654): true when the agent has a heartbeat run in "running" (bot-decommission.ts). */
export function agentHasRunningRun(db: Db): (agentId: string) => Promise<boolean> {
  return async (agentId) => {
    if (!UUID_PATTERN.test(agentId)) return false;
    const rows = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "running")))
      .limit(1);
    return rows.length > 0;
  };
}

/**
 * Agents of a company that have bot-container enabled on a hermes_gateway card.
 * Used by GET /myrmidon/companies/:companyId/bot-containers/status.
 */
export function listCompanyBotContainerAgents(db: Db): (companyId: string) => Promise<BotContainerRouteAgent[]> {
  return async (companyId: string) => {
    if (!UUID_PATTERN.test(companyId)) return [];
    const rows = await db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        adapterType: agents.adapterType,
        adapterConfig: agents.adapterConfig,
        runtimeConfig: agents.runtimeConfig,
        status: agents.status,
      })
      .from(agents)
      .where(
        and(
          eq(agents.companyId, companyId),
          eq(agents.adapterType, HERMES_GATEWAY_ADAPTER_TYPE),
          ne(agents.status, "terminated"),
          sql`${agents.adapterConfig} #> '{container,enabled}' = 'true'::jsonb`,
        ),
      )
      .orderBy(agents.id);
    return rows;
  };
}
