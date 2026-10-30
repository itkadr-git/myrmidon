// server/src/myrmidon/architect-data/service.ts
//
// myrmidon(1.6.6 ARCH-DATA): read-only product access for the architect role
// to full operational metrics without secrets:
// 1. Hermes context compression events from agent logs
// 2. ChatGPT pool router limits & requests from sqlite /stats/usage.db
// 3. LiteLLM model spend calls without text bodies
// 4. Board heartbeat runs

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { and, desc, eq, gte, ne } from "drizzle-orm";
import {
  agents,
  heartbeatRuns,
  litellmCostEvents,
  type Db,
} from "@myrmidon/db";
import {
  scrubSecrets,
  type ArchitectDataBundle,
  type ArchitectDataQuery,
  type ChatgptPoolData,
  type ChatgptPoolLimit,
  type ChatgptPoolReq,
  type HeartbeatRunSummary,
  type HermesCompressionEvent,
  type LlmSpendCall,
  ARCHITECT_DATA_DEFAULT_ALLOWED_ROLES,
} from "@myrmidon/shared";
import { forbidden, unauthorized } from "../../errors.js";
import type { Request } from "express";

export interface ArchitectDataServiceOptions {
  botVolumeRoot?: string;
  chatgptUsageDbPath?: string;
  allowedRoles?: string[];
}

/** Check whether the actor has architect access */
export async function assertArchitectRoleOrGrant(
  req: Request,
  db: Db,
  companyId: string,
  allowedRoles?: string[],
): Promise<void> {
  const actor = req.actor;
  if (!actor || actor.type === "none") {
    throw unauthorized();
  }

  // Board users have access to company metrics
  if (actor.type === "board") {
    return;
  }

  // For agent actors, verify role
  if (actor.type === "agent" && actor.agentId) {
    const configuredRoles = allowedRoles ?? (
      process.env.ARCHITECT_DATA_ALLOWED_ROLES
        ? process.env.ARCHITECT_DATA_ALLOWED_ROLES.split(",").map((r) => r.trim().toLowerCase())
        : [...ARCHITECT_DATA_DEFAULT_ALLOWED_ROLES]
    );

    const [agentRow] = await db
      .select({ role: agents.role, name: agents.name })
      .from(agents)
      .where(and(eq(agents.id, actor.agentId), eq(agents.companyId, companyId)))
      .limit(1);

    if (!agentRow) {
      throw forbidden("Agent not found in company");
    }

    const role = (agentRow.role ?? "").toLowerCase();
    if (configuredRoles.includes(role)) {
      return;
    }

    throw forbidden(
      `Architect data access restricted: role '${role}' is not in allowed roles (${configuredRoles.join(", ")})`,
    );
  }

  throw forbidden("Architect data requires the architect role or an authorized actor");
}

/**
 * 1. Read Hermes context compression/compaction events from bot logs.
 * Path: /srv/myrmidon-bots/<agent>/hermes/logs/agent.log* for all non-terminated agents.
 */
export async function getHermesCompressionEvents(
  db: Db,
  companyId: string,
  options: {
    agentId?: string;
    limit?: number;
    botVolumeRoot?: string;
  } = {},
): Promise<HermesCompressionEvent[]> {
  const limit = Math.min(Math.max(options.limit ?? 500, 1), 2000);
  const rootDir = options.botVolumeRoot ?? process.env.MYRMIDON_BOT_VOLUME_ROOT ?? "/srv/myrmidon-bots";

  // List non-terminated agents for the company
  const agentConditions = [eq(agents.companyId, companyId), ne(agents.status, "terminated")];
  if (options.agentId) {
    agentConditions.push(eq(agents.id, options.agentId));
  }

  const agentRows = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(and(...agentConditions));

  const results: HermesCompressionEvent[] = [];

  const compressionKeywords = /(?:compress|compaction|compacted|session compressed|context compression|tokens|pruned context)/i;

  for (const agent of agentRows) {
    if (results.length >= limit) break;

    // Check possible directory names: agent id or agent name
    const candidateDirs = [
      path.join(rootDir, agent.id, "hermes", "logs"),
      path.join(rootDir, agent.name, "hermes", "logs"),
    ];

    for (const logDir of candidateDirs) {
      if (!fs.existsSync(logDir)) continue;

      try {
        const files = await fsp.readdir(logDir);
        const logFiles = files
          .filter((f) => f.startsWith("agent.log"))
          .sort()
          .reverse();

        for (const file of logFiles) {
          if (results.length >= limit) break;
          const filePath = path.join(logDir, file);
          try {
            const content = await fsp.readFile(filePath, "utf-8");
            const lines = content.split(/\r?\n/);

            for (const line of lines) {
              if (results.length >= limit) break;
              if (!line.trim()) continue;

              if (compressionKeywords.test(line)) {
                // Extract possible timestamp at start of log line
                const matchDate = line.match(/^(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/);
                results.push({
                  agent: agent.name || agent.id,
                  line: scrubSecrets(line),
                  timestamp: matchDate ? matchDate[1] : null,
                });
              }
            }
          } catch {
            // Skip unreadable files
          }
        }
      } catch {
        // Skip inaccessible dirs
      }
    }
  }

  return results.slice(0, limit);
}

/**
 * 2. Read ChatGPT pool channel limits and requests from sqlite /stats/usage.db.
 */
export async function getChatgptPoolData(
  options: {
    hours?: number;
    limit?: number;
    dbPath?: string;
  } = {},
): Promise<ChatgptPoolData> {
  const hours = options.hours ?? 48;
  const limit = Math.min(Math.max(options.limit ?? 500, 1), 2000);
  const dbPath = options.dbPath ?? process.env.CHATGPT_USAGE_DB_PATH ?? "/stats/usage.db";

  if (!fs.existsSync(dbPath)) {
    return { limits: [], reqs: [] };
  }

  try {
    const sqlite = new DatabaseSync(dbPath, { readOnly: true });
    try {
      // Query limits table
      let limits: ChatgptPoolLimit[] = [];
      try {
        const stmt = sqlite.prepare(
          "SELECT acc, ts, plan, active_limit, p_used, p_window_min, p_reset_at, s_used, s_window_min, s_reset_at FROM limits ORDER BY ts DESC LIMIT ?",
        );
        const rows = stmt.all(limit) as Record<string, unknown>[];
        limits = rows.map((r) => ({
          acc: scrubSecrets(String(r.acc ?? "")),
          ts: typeof r.ts === "number" || typeof r.ts === "string" ? r.ts : String(r.ts ?? ""),
          plan: typeof r.plan === "string" ? r.plan : null,
          active_limit: typeof r.active_limit === "number" ? r.active_limit : null,
          p_used: typeof r.p_used === "number" ? r.p_used : null,
          p_window_min: typeof r.p_window_min === "number" ? r.p_window_min : null,
          p_reset_at: typeof r.p_reset_at === "number" || typeof r.p_reset_at === "string" ? r.p_reset_at : null,
          s_used: typeof r.s_used === "number" ? r.s_used : null,
          s_window_min: typeof r.s_window_min === "number" ? r.s_window_min : null,
          s_reset_at: typeof r.s_reset_at === "number" || typeof r.s_reset_at === "string" ? r.s_reset_at : null,
        }));
      } catch {
        // Table may not exist yet
      }

      // Query req table for the last N hours
      let reqs: ChatgptPoolReq[] = [];
      try {
        const cutoffTs = Math.floor(Date.now() / 1000) - hours * 3600;
        const stmt = sqlite.prepare(
          "SELECT id, acc, ts, model, status FROM req WHERE ts >= ? ORDER BY ts DESC LIMIT ?",
        );
        const rows = stmt.all(cutoffTs, limit) as Record<string, unknown>[];
        reqs = rows.map((r) => ({
          id: typeof r.id === "number" || typeof r.id === "string" ? r.id : null,
          acc: typeof r.acc === "string" ? scrubSecrets(r.acc) : null,
          ts: typeof r.ts === "number" || typeof r.ts === "string" ? r.ts : String(r.ts ?? ""),
          model: typeof r.model === "string" ? r.model : null,
          status: typeof r.status === "number" || typeof r.status === "string" ? r.status : null,
        }));
      } catch {
        // Table may not exist yet
      }

      return { limits, reqs };
    } finally {
      sqlite.close();
    }
  } catch {
    return { limits: [], reqs: [] };
  }
}

/**
 * 3. Read LiteLLM spend calls (without text bodies and without secrets).
 */
export async function getLlmCalls(
  db: Db,
  companyId: string,
  options: {
    hours?: number;
    limit?: number;
    agentId?: string;
  } = {},
): Promise<LlmSpendCall[]> {
  const hours = options.hours ?? 48;
  const limit = Math.min(Math.max(options.limit ?? 500, 1), 2000);
  const sinceDate = new Date(Date.now() - hours * 3600 * 1000);

  const conditions = [
    eq(litellmCostEvents.companyId, companyId),
    gte(litellmCostEvents.occurredAt, sinceDate),
  ];

  if (options.agentId) {
    conditions.push(eq(litellmCostEvents.agentId, options.agentId));
  }

  const rows = await db
    .select()
    .from(litellmCostEvents)
    .where(and(...conditions))
    .orderBy(desc(litellmCostEvents.occurredAt))
    .limit(limit);

  return rows.map((row) => ({
    agentId: row.agentId,
    issueId: row.issueId,
    heartbeatRunId: row.heartbeatRunId,
    provider: row.provider,
    model: row.model,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    costCents: row.costCents,
    occurredAt: row.occurredAt instanceof Date ? row.occurredAt.toISOString() : String(row.occurredAt),
    requestId: null,
    spend: row.costCents / 100,
  }));
}

/**
 * 4. Read board heartbeat runs.
 */
export async function getHeartbeatRuns(
  db: Db,
  companyId: string,
  options: {
    hours?: number;
    limit?: number;
    agentId?: string;
  } = {},
): Promise<HeartbeatRunSummary[]> {
  const hours = options.hours ?? 48;
  const limit = Math.min(Math.max(options.limit ?? 500, 1), 2000);
  const sinceDate = new Date(Date.now() - hours * 3600 * 1000);

  const conditions = [
    eq(heartbeatRuns.companyId, companyId),
    gte(heartbeatRuns.createdAt, sinceDate),
  ];

  if (options.agentId) {
    conditions.push(eq(heartbeatRuns.agentId, options.agentId));
  }

  const rows = await db
    .select({
      id: heartbeatRuns.id,
      agentId: heartbeatRuns.agentId,
      status: heartbeatRuns.status,
      startedAt: heartbeatRuns.startedAt,
      finishedAt: heartbeatRuns.finishedAt,
      error: heartbeatRuns.error,
      createdAt: heartbeatRuns.createdAt,
      updatedAt: heartbeatRuns.updatedAt,
    })
    .from(heartbeatRuns)
    .where(and(...conditions))
    .orderBy(desc(heartbeatRuns.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    agentId: row.agentId,
    status: row.status,
    startedAt: row.startedAt instanceof Date ? row.startedAt.toISOString() : row.startedAt ? String(row.startedAt) : null,
    finishedAt: row.finishedAt instanceof Date ? row.finishedAt.toISOString() : row.finishedAt ? String(row.finishedAt) : null,
    error: row.error ? scrubSecrets(String(row.error)) : null,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
  }));
}

/**
 * Bundle all four operational metrics sources together.
 */
export async function getArchitectDataBundle(
  db: Db,
  companyId: string,
  query: ArchitectDataQuery,
  options: ArchitectDataServiceOptions = {},
): Promise<ArchitectDataBundle> {
  const [compressionEvents, chatgptPool, llmCalls, runs] = await Promise.all([
    getHermesCompressionEvents(db, companyId, {
      agentId: query.agentId,
      limit: query.limit,
      botVolumeRoot: options.botVolumeRoot,
    }),
    getChatgptPoolData({
      hours: query.hours,
      limit: query.limit,
      dbPath: options.chatgptUsageDbPath,
    }),
    getLlmCalls(db, companyId, {
      hours: query.hours,
      limit: query.limit,
      agentId: query.agentId,
    }),
    getHeartbeatRuns(db, companyId, {
      hours: query.hours,
      limit: query.limit,
      agentId: query.agentId,
    }),
  ]);

  return {
    compressionEvents,
    chatgptPool,
    llmCalls,
    heartbeatRuns: runs,
    collectedAt: new Date().toISOString(),
  };
}
