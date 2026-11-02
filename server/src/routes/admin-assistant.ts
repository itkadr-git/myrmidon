import fs from "node:fs/promises";
import { Router, type Request, type Response } from "express";
import { and, count, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { agents, heartbeatRuns, issues } from "@myrmidon/db";
import { assertCompanyAccess, assertInstanceAdmin } from "./authz.js";
import { badRequest } from "../errors.js";
import { redactSensitive } from "../middleware/redact-sensitive.js";

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

// ─── Dry-run diagnostics ─────────────────────────────────────────────────────

export type DryRunProbeStatus = "ok" | "degraded";

export interface DryRunProbeResult {
  name: string;
  status: DryRunProbeStatus;
  durationMs: number;
  detail?: Record<string, unknown>;
  error?: string;
}

export interface AdminAssistantDryRunDiagnostics {
  dry_run: true;
  timestamp: string;
  probes: DryRunProbeResult[];
  summary: {
    total: number;
    ok: number;
    degraded: number;
  };
}

/** Default per-probe timeout. Each probe runs in isolation; a slow probe
 * degrades its own result without hiding the error or blocking siblings. */
export const DRY_RUN_PROBE_TIMEOUT_MS = 5_000;

function isTimeoutError(err: unknown): boolean {
  return (
    (err instanceof Error && err.name === "AbortError") ||
    (err instanceof Error && err.name === "TimeoutError") ||
    (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ABORT_ERR")
  );
}

function probeErrorMessage(err: unknown, timeoutMs: number): string {
  if (isTimeoutError(err)) {
    return err instanceof Error && err.message.includes("timed out")
      ? err.message
      : `timed out after ${timeoutMs}ms`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Run a single probe with its own timeout. Never rejects. */
async function runDryRunProbe(
  name: string,
  probe: () => Promise<Record<string, unknown>>,
  timeoutMs: number = DRY_RUN_PROBE_TIMEOUT_MS,
): Promise<DryRunProbeResult> {
  const started = Date.now();
  try {
    const detail = await Promise.race([
      probe(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => {
          const err = new Error(`timed out after ${timeoutMs}ms`);
          err.name = "TimeoutError";
          reject(err);
        }, timeoutMs).unref?.(),
      ),
    ]);
    return { name, status: "ok", durationMs: Date.now() - started, detail };
  } catch (err) {
    return {
      name,
      status: "degraded",
      durationMs: Date.now() - started,
      error: probeErrorMessage(err, timeoutMs),
    };
  }
}

/** Strict read-only probes: only `db.select` and `fs.statfs`. No INSERT/UPDATE/DELETE. */
function buildDryRunProbes(db: Db): Array<{ name: string; run: () => Promise<Record<string, unknown>> }> {
  return [
    {
      name: "agents_summary",
      run: async () => {
        const rows = await db
          .select({ status: agents.status })
          .from(agents);
        const summary: Record<string, number> = {};
        for (const row of rows) {
          const key = typeof row.status === "string" ? row.status : "unknown";
          summary[key] = (summary[key] ?? 0) + 1;
        }
        return { total: rows.length, byStatus: summary };
      },
    },
    {
      name: "open_tasks_summary",
      run: async () => {
        const rows = await db
          .select({ status: issues.status })
          .from(issues)
          .where(isNull(issues.hiddenAt));
        const summary: Record<string, number> = {};
        for (const row of rows) {
          const key = typeof row.status === "string" ? row.status : "unknown";
          summary[key] = (summary[key] ?? 0) + 1;
        }
        return { total: rows.length, byStatus: summary };
      },
    },
    {
      name: "heartbeat_runs_summary",
      run: async () => {
        const rows = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns);
        const summary: Record<string, number> = {};
        for (const row of rows) {
          const key = typeof row.status === "string" ? row.status : "unknown";
          summary[key] = (summary[key] ?? 0) + 1;
        }
        return { total: rows.length, byStatus: summary };
      },
    },
    {
      name: "disk_usage",
      run: async () => {
        const disk = await measureDiskSpaceSafe();
        return { ...disk };
      },
    },
  ];
}

/**
 * Collect admin-assistant dry-run diagnostics.
 *
 * Guarantees:
 * - Every probe is strictly read-only (only SELECT queries and fs.statfs).
 * - Each probe has an independent timeout; a timeout or error degrades that
 *   probe's result but does not hide the error string and does not block
 *   the other probes.
 * - The returned payload carries an explicit `dry_run: true` marker.
 * - The response is passed through `redactSensitive` before leaving the route
 *   so any credential-shaped field that a probe might accidentally include is
 *   masked with "[REDACTED]".
 */
export async function collectDryRunDiagnostics(
  db: Db,
  options?: { now?: Date; probeTimeoutMs?: number; probes?: Array<{ name: string; run: () => Promise<Record<string, unknown>> }> },
): Promise<AdminAssistantDryRunDiagnostics> {
  const now = options?.now ?? new Date();
  const timeoutMs = options?.probeTimeoutMs ?? DRY_RUN_PROBE_TIMEOUT_MS;
  const probes = options?.probes ?? buildDryRunProbes(db);
  const results = await Promise.all(
    probes.map((p) => runDryRunProbe(p.name, p.run, timeoutMs)),
  );
  const ok = results.filter((r) => r.status === "ok").length;
  return {
    dry_run: true,
    timestamp: now.toISOString(),
    probes: results,
    summary: {
      total: results.length,
      ok,
      degraded: results.length - ok,
    },
  };
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

  async function handleDryRunDiagnostics(req: Request, res: Response) {
    // The dry-run diagnostics endpoint is intentionally stricter than the
    // cluster-health route: it always requires instance admin, even when a
    // companyId query parameter is present, because it returns instance-wide
    // probe results that may cross company boundaries.
    assertInstanceAdmin(req);

    const diagnostics = await collectDryRunDiagnostics(db);
    // Defense in depth: run the payload through the same redaction walker
    // used for HTTP log lines so a probe that accidentally surfaces a
    // credential-shaped key never leaves the process unmasked.
    res.json(redactSensitive(diagnostics));
  }

  router.get("/companies/:companyId/admin-assistant/cluster-health", handleClusterHealth);
  router.get("/admin-assistant/cluster-health", handleClusterHealth);
  router.get("/admin-assistant/health", handleClusterHealth);
  router.get("/admin-assistant/dry-run", handleDryRunDiagnostics);

  return router;
}
