import fs from "node:fs/promises";

/**
 * Tool name for the built-in admin-assistant cluster health check.
 */
export const CLUSTER_HEALTH_CHECK_TOOL_NAME = "cluster_health_check";

/**
 * LiteLLM / OpenAI compatible function calling schema definition.
 */
export const clusterHealthCheckToolDefinition = {
  type: "function" as const,
  function: {
    name: CLUSTER_HEALTH_CHECK_TOOL_NAME,
    description:
      "Diagnostics tool for the admin assistant model: collects a compact instance health summary including active agents, queued tasks, heartbeat delays, and remaining disk space without invoking shell commands.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Optional filesystem directory path to check remaining disk space for (default: current working directory or data directory)",
        },
        companyId: {
          type: "string",
          description:
            "Optional company ID to scope the agent, task, and heartbeat metrics",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
};

/**
 * Alias for the LiteLLM tool definition schema.
 */
export const clusterHealthCheckToolSchema = clusterHealthCheckToolDefinition;

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

export interface ClusterHealthCheckParams {
  path?: string;
  companyId?: string;
}

export interface ClusterHealthMetricsProvider {
  getAgents?: (companyId?: string) => Promise<ClusterHealthAgentsSummary> | ClusterHealthAgentsSummary;
  getTasks?: (companyId?: string) => Promise<ClusterHealthTasksSummary> | ClusterHealthTasksSummary;
  getHeartbeats?: (companyId?: string) => Promise<ClusterHealthHeartbeatsSummary> | ClusterHealthHeartbeatsSummary;
  getDisk?: (targetPath?: string) => Promise<ClusterHealthDiskUsage> | ClusterHealthDiskUsage;
}

export interface ClusterHealthCheckOptions {
  metricsProvider?: ClusterHealthMetricsProvider;
  apiBaseUrl?: string;
  authToken?: string;
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
}

/**
 * Safely measures filesystem usage for the given directory without executing any shell commands.
 * Uses Node.js fs.statfs POSIX syscall.
 */
export async function measureDiskSpaceSafe(targetPath?: string): Promise<ClusterHealthDiskUsage> {
  const dir = targetPath || process.env.MYRMIDON_DATA_DIR || process.cwd() || "/";
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
 * Executes the cluster health check tool safely without spawning any shell commands.
 */
export async function executeClusterHealthCheck(
  params?: ClusterHealthCheckParams,
  options?: ClusterHealthCheckOptions,
): Promise<ClusterHealthCheckResult> {
  const provider = options?.metricsProvider;

  // 1. If remote API endpoint is provided, try fetching from the server route
  if (options?.apiBaseUrl) {
    const fetchFn = options.fetcher || globalThis.fetch;
    const url = new URL("/admin-assistant/cluster-health", options.apiBaseUrl);
    if (params?.path) url.searchParams.set("path", params.path);
    if (params?.companyId) url.searchParams.set("companyId", params.companyId);

    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.authToken) {
      headers["Authorization"] = `Bearer ${options.authToken}`;
    }

    try {
      const response = await fetchFn(url.toString(), { headers });
      if (response.ok) {
        return (await response.json()) as ClusterHealthCheckResult;
      }
    } catch {
      // Fall through to local collection if fetch fails
    }
  }

  // 2. Collect disk space metrics safely via fs.statfs
  const disk = provider?.getDisk
    ? await provider.getDisk(params?.path)
    : await measureDiskSpaceSafe(params?.path);

  // 3. Collect agent metrics
  const agents: ClusterHealthAgentsSummary = provider?.getAgents
    ? await provider.getAgents(params?.companyId)
    : { total: 0, active: 0, idle: 0, paused: 0, error: 0 };

  // 4. Collect task queue metrics
  const tasks: ClusterHealthTasksSummary = provider?.getTasks
    ? await provider.getTasks(params?.companyId)
    : { queued: 0, inProgress: 0, blocked: 0, totalOpen: 0 };

  // 5. Collect heartbeat delays and status
  const heartbeats: ClusterHealthHeartbeatsSummary = provider?.getHeartbeats
    ? await provider.getHeartbeats(params?.companyId)
    : { activeRuns: 0, maxDelayMs: 0, staleCount: 0, status: "healthy" };

  // 6. Aggregate overall status
  let overallStatus: HealthStatus = "healthy";
  if (disk.status === "critical" || heartbeats.status === "critical" || agents.error > 0) {
    overallStatus = "critical";
  } else if (disk.status === "warning" || heartbeats.status === "warning" || tasks.blocked > 0) {
    overallStatus = "warning";
  }

  return {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    agents,
    tasks,
    heartbeats,
    disk,
  };
}

/**
 * Admin-assistant tool instance packaging schema definition and execution handler.
 */
export const clusterHealthCheckTool = {
  name: CLUSTER_HEALTH_CHECK_TOOL_NAME,
  definition: clusterHealthCheckToolDefinition,
  schema: clusterHealthCheckToolSchema,
  execute: executeClusterHealthCheck,
};
