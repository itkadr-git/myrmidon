import fs from "node:fs/promises";
import { Router, type Request, type Response } from "express";
import { and, count, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { agents, heartbeatRuns, issues } from "@myrmidon/db";
import { assertCompanyAccess, assertInstanceAdmin } from "./authz.js";
import { badRequest } from "../errors.js";

export type HealthStatus = "healthy" | "warning" | "critical";

export interface ClusterHealthDiskUsage {
  path: string;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number;
  status: HealthStatus;
}

export interface ClusterHealthAgentsSummary {
  total: number;
  active: number;
  idle: number;
  paused: number;
  error: number;
}

export interface ClusterHealthTasksSummary {
  queued: number;
  inProgress: number;
  blocked: number;
  totalOpen: number;
}

export interface ClusterHealthHeartbeatsSummary {
  activeRuns: number;
  maxDelayMs: number;
  staleCount: number;
  status: HealthStatus;
}

export interface ClusterHealthCheckResult {
  status: HealthStatus;
  timestamp: string;
  agents: ClusterHealthAgentsSummary;
  tasks: ClusterHealthTasksSummary;
  heartbeats: ClusterHealthHeartbeatsSummary;
  disk: ClusterHealthDiskUsage;
}

export interface CollectClusterHealthOptions {
  companyId?: string;
  diskPath?: string;
  now?: Date;
}

/**
 * Safely measures filesystem usage for the given directory without executing any shell commands.
 * Uses Node.js fs.statfs POSIX syscall.
 */
export async function measureDiskSpaceSafe(targetPath?: string): Promise<ClusterHealthDiskUsage> {
  const dataDir = process.env.MYRMIDON_DATA_DIR || process.cwd() || "/";
  const dir = targetPath || dataDir;
  if (targetPath && targetPath !== dataDir) {
    throw badRequest("diskPath must be the configured data directory");
  }
  try {
    const stats = await fs.statfs(dir);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);

    if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
      return {
        path: dir,
        totalBytes: 0,
        freeBytes: 0,
        usedBytes: 0,
        usedPercent: 0,
        status: "warning",
      };
    }

    const usedBytes = Math.max(0, totalBytes - freeBytes);
    const usedPercent = Math.min(100, Math.max(0, Math.round((usedBytes / totalBytes) * 100)));

    let status: HealthStatus = "healthy";
    if (usedPercent >= 90) {
      status = "critical";
    } else if (usedPercent >= 80) {
      status = "warning";
    }

    return {
      path: dir,
      totalBytes,
      freeBytes,
      usedBytes,
      usedPercent,
      status,
    };
  } catch {
    return {
      path: dir,
      totalBytes: 0,
      freeBytes: 0,
      usedBytes: 0,
      usedPercent: 0,
      status: "warning",
    };
  }
}

/**
 * Collects a compact instance health check summary from database state and safe fs.statfs measurements.
 * Safe execution without invoking shell commands.
 */
export async function collectClusterHealth(
  db: Db,
  options?: CollectClusterHealthOptions,
): Promise<ClusterHealthCheckResult> {
  const companyId = options?.companyId;
  const now = (options?.now ?? new Date()).getTime();

  // 1. Collect agent status metrics
  let agentRows: { id: string; status: string; lastHeartbeatAt: Date | null }[] = [];
  try {
    const query = companyId
      ? db
          .select({
            id: agents.id,
            status: agents.status,
            lastHeartbeatAt: agents.lastHeartbeatAt,
          })
          .from(agents)
          .where(eq(agents.companyId, companyId))
      : db
          .select({
            id: agents.id,
            status: agents.status,
            lastHeartbeatAt: agents.lastHeartbeatAt,
          })
          .from(agents);
    agentRows = await query;
  } catch {
    // If DB query fails, keep empty array
  }

  let activeAgents = 0;
  let idleAgents = 0;
  let pausedAgents = 0;
  let errorAgents = 0;

  for (const agent of agentRows) {
    if (agent.status === "paused") {
      pausedAgents++;
    } else if (agent.status === "error") {
      errorAgents++;
    } else if (agent.status === "idle") {
      idleAgents++;
    } else {
      activeAgents++;
    }
  }

  const agentsSummary: ClusterHealthAgentsSummary = {
    total: agentRows.length,
    active: activeAgents,
    idle: idleAgents,
    paused: pausedAgents,
    error: errorAgents,
  };

  // 2. Collect task queue metrics from issues table
  let queuedTasks = 0;
  let inProgressTasks = 0;
  let blockedTasks = 0;

  try {
    const conditions = [isNull(issues.hiddenAt)];
    if (companyId) {
      conditions.push(eq(issues.companyId, companyId));
    }

    const issueRows = await db
      .select({ status: issues.status })
      .from(issues)
      .where(and(...conditions));

    for (const issue of issueRows) {
      if (issue.status === "todo" || issue.status === "backlog") {
        queuedTasks++;
      } else if (issue.status === "in_progress") {
        inProgressTasks++;
      } else if (issue.status === "blocked") {
        blockedTasks++;
      }
    }
  } catch {
    // If DB query fails, keep zeroes
  }

  const tasksSummary: ClusterHealthTasksSummary = {
    queued: queuedTasks,
    inProgress: inProgressTasks,
    blocked: blockedTasks,
    totalOpen: queuedTasks + inProgressTasks + blockedTasks,
  };

  // 3. Collect active heartbeat runs and agent heartbeat delay metrics
  let activeRuns = 0;
  try {
    const runConditions = [inArray(heartbeatRuns.status, ["queued", "running"])];
    if (companyId) {
      runConditions.push(eq(heartbeatRuns.companyId, companyId));
    }
    const runRows = await db
      .select({ count: count() })
      .from(heartbeatRuns)
      .where(and(...runConditions));
    activeRuns = Number(runRows[0]?.count ?? 0);
  } catch {
    // If DB query fails, keep 0
  }

  let maxDelayMs = 0;
  let staleCount = 0;

  for (const agent of agentRows) {
    if (agent.status !== "paused" && agent.lastHeartbeatAt) {
      const delay = Math.max(0, now - agent.lastHeartbeatAt.getTime());
      if (delay > maxDelayMs) {
        maxDelayMs = delay;
      }
      if (delay > 120_000) {
        staleCount++;
      }
    }
  }

  let heartbeatsStatus: HealthStatus = "healthy";
  if (staleCount >= 3 || maxDelayMs >= 300_000) {
    heartbeatsStatus = "critical";
  } else if (staleCount > 0 || maxDelayMs >= 60_000) {
    heartbeatsStatus = "warning";
  }

  const heartbeatsSummary: ClusterHealthHeartbeatsSummary = {
    activeRuns,
    maxDelayMs,
    staleCount,
    status: heartbeatsStatus,
  };

  // 4. Safely measure remaining disk space without shell commands
  const disk = await measureDiskSpaceSafe(options?.diskPath);

  // 5. Aggregate overall cluster health status
  let overallStatus: HealthStatus = "healthy";
  if (disk.status === "critical" || heartbeatsStatus === "critical" || errorAgents > 0) {
    overallStatus = "critical";
  } else if (disk.status === "warning" || heartbeatsStatus === "warning" || blockedTasks > 0) {
    overallStatus = "warning";
  }

  return {
    status: overallStatus,
    timestamp: new Date(now).toISOString(),
    agents: agentsSummary,
    tasks: tasksSummary,
    heartbeats: heartbeatsSummary,
    disk,
  };
}

/**
 * Express router for admin-assistant cluster diagnostics.
 */
export function adminAssistantRoutes(db: Db): Router {
  const router = Router();

  async function handleClusterHealth(req: Request, res: Response) {
    const companyId = (req.params.companyId || req.query.companyId) as string | undefined;
    if (req.params.companyId) {
      assertCompanyAccess(req, companyId as string);
    } else if (companyId) {
      assertCompanyAccess(req, companyId);
    } else {
      assertInstanceAdmin(req);
    }

    const diskPath = (req.query.path || req.query.diskPath) as string | undefined;
    const health = await collectClusterHealth(db, { companyId, diskPath });
    res.json(health);
  }

  router.get("/companies/:companyId/admin-assistant/cluster-health", handleClusterHealth);
  router.get("/admin-assistant/cluster-health", handleClusterHealth);
  router.get("/admin-assistant/health", handleClusterHealth);

  return router;
}
