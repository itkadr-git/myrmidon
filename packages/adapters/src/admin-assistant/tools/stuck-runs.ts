/**
 * Tool name for the built-in admin-assistant detect stuck runs tool.
 */
export const DETECT_STUCK_RUNS_TOOL_NAME = "detect_stuck_runs";

/**
 * LiteLLM / OpenAI compatible function calling schema definition.
 */
export const detectStuckRunsToolDefinition = {
  type: "function" as const,
  function: {
    name: DETECT_STUCK_RUNS_TOOL_NAME,
    description:
      "Detects in_progress tasks whose heartbeat run has not updated longer than a timeout, returning affected tasks, agents, silence duration, and recovery recommendations (unblock, restart, escalate).",
    parameters: {
      type: "object",
      properties: {
        timeoutMs: {
          type: "number",
          description:
            "Inactivity timeout threshold in milliseconds (default: 300000 = 5 minutes)",
        },
        timeoutSeconds: {
          type: "number",
          description: "Optional inactivity timeout threshold in seconds",
        },
        companyId: {
          type: "string",
          description: "Optional company ID to scope the search for stuck runs",
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
export const detectStuckRunsToolSchema = detectStuckRunsToolDefinition;

export type StuckRunRecoveryAction = "разблокировка" | "рестарт" | "эскалация";
export type StuckRunActionCode = "unblock" | "restart" | "escalate";

export interface DetermineRecoveryActionInput {
  silenceMs: number;
  timeoutMs: number;
  runStatus?: string | null;
  hasLock?: boolean;
  agentStatus?: string | null;
  attemptCount?: number;
}

export interface RecoveryActionRecommendation {
  action: StuckRunRecoveryAction;
  suggestedAction: StuckRunRecoveryAction;
  actionCode: StuckRunActionCode;
  reason: string;
}

/**
 * Determines the suggested recovery action according to inactivity duration,
 * execution lock state, and agent/run status:
 * - "эскалация" (escalate): critical silence (>= 3x timeout), agent in error, or excessive retries
 * - "разблокировка" (unblock): task holds execution lock without active process, or run is stopped/blocked
 * - "рестарт" (restart): active process timed out without heartbeats within normal recovery threshold
 */
export function determineRecoveryAction(
  params: DetermineRecoveryActionInput,
): RecoveryActionRecommendation {
  const { silenceMs, timeoutMs, runStatus, hasLock, agentStatus, attemptCount } = params;

  // 1. Escalation:
  // Extreme silence duration (>= 3x timeout threshold), or agent in error status, or excessive retries
  if (silenceMs >= timeoutMs * 3 || agentStatus === "error" || (attemptCount !== undefined && attemptCount >= 3)) {
    return {
      action: "эскалация",
      suggestedAction: "эскалация",
      actionCode: "escalate",
      reason: `Превышен критический порог молчания (${Math.round(silenceMs / 1000)}с) или ошибка агента; требуется эскалация оператору`,
    };
  }

  // 2. Unblock (разблокировка):
  // Task is marked in_progress with execution lock, but the run is stopped, failed, timed out, or blocked
  if (
    runStatus === "blocked" ||
    (hasLock && (!runStatus || runStatus === "failed" || runStatus === "timed_out" || runStatus === "interrupted" || runStatus === "completed"))
  ) {
    return {
      action: "разблокировка",
      suggestedAction: "разблокировка",
      actionCode: "unblock",
      reason: "Задача удерживает блокировку исполнения без активного процесса; требуется разблокировка",
    };
  }

  // 3. Restart (рестарт):
  // Active run ('running' or 'queued') that exceeded timeout without recent heartbeat updates
  return {
    action: "рестарт",
    suggestedAction: "рестарт",
    actionCode: "restart",
    reason: `Прогон молчит ${Math.round(silenceMs / 1000)}с; требуется рестарт процесса`,
  };
}

export interface StuckRunItem {
  issueId: string;
  taskId: string;
  identifier?: string | null;
  title?: string | null;
  agentId: string;
  agent: string;
  runId: string | null;
  runStatus: string | null;
  silenceMs: number;
  silenceTime: number;
  silenceDurationMs: number;
  lastHeartbeatAt: string | null;
  lastUpdatedAt: string | null;
  suggestedAction: StuckRunRecoveryAction;
  action: StuckRunRecoveryAction;
  actionCode: StuckRunActionCode;
  reason: string;
}

export type DetectStuckRunsResult = StuckRunItem[] & {
  total: number;
  timeoutMs: number;
  runs: StuckRunItem[];
  items: StuckRunItem[];
};

export interface DetectStuckRunsParams {
  timeoutMs?: number;
  timeoutSeconds?: number;
  companyId?: string;
}

export interface StuckRunsProvider {
  getStuckRuns?: (
    params?: DetectStuckRunsParams,
  ) => Promise<StuckRunItem[] | DetectStuckRunsResult> | StuckRunItem[] | DetectStuckRunsResult;
}

export interface DetectStuckRunsOptions {
  provider?: StuckRunsProvider;
  metricsProvider?: StuckRunsProvider;
  db?: any;
  apiBaseUrl?: string;
  authToken?: string;
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
  now?: Date;
}

/**
 * Detects stuck runs against a database or test database records.
 * Supports Drizzle query builders as well as in-memory test databases.
 */
export async function detectStuckRuns(
  db: any,
  options?: {
    timeoutMs?: number;
    timeoutSeconds?: number;
    companyId?: string;
    now?: Date;
  },
): Promise<DetectStuckRunsResult> {
  const timeoutMs =
    options?.timeoutMs ??
    (options?.timeoutSeconds !== undefined ? options.timeoutSeconds * 1000 : 300_000);
  const companyId = options?.companyId;
  const now = options?.now ?? new Date();
  const nowMs = now.getTime();

  let issueRows: any[] = [];
  let runRows: any[] = [];
  let agentRows: any[] = [];

  // Check if db is a direct in-memory test fixture
  if (db && !db.select && (Array.isArray(db.issues) || Array.isArray(db.heartbeatRuns))) {
    issueRows = (db.issues ?? []).filter((i: any) => {
      const matchStatus = i.status === "in_progress";
      const matchCompany = !companyId || i.companyId === companyId;
      const notHidden = !i.hiddenAt;
      return matchStatus && matchCompany && notHidden;
    });
    runRows = db.heartbeatRuns ?? [];
    agentRows = db.agents ?? [];
  } else if (db && typeof db.select === "function") {
    // Drizzle ORM or mock DB query
    try {
      const issuesQuery = db.select().from(db.schema?.issues ?? "issues");
      const issuesResult = await (typeof issuesQuery.where === "function" ? issuesQuery.where() : issuesQuery);
      issueRows = (issuesResult ?? []).filter((i: any) => {
        const matchStatus = i.status === "in_progress";
        const matchCompany = !companyId || i.companyId === companyId;
        const notHidden = !i.hiddenAt;
        return matchStatus && matchCompany && notHidden;
      });
    } catch {
      issueRows = [];
    }

    try {
      const runsQuery = db.select().from(db.schema?.heartbeatRuns ?? "heartbeatRuns");
      runRows = await (typeof runsQuery.where === "function" ? runsQuery.where() : runsQuery);
    } catch {
      runRows = [];
    }

    try {
      const agentsQuery = db.select().from(db.schema?.agents ?? "agents");
      agentRows = await (typeof agentsQuery.where === "function" ? agentsQuery.where() : agentsQuery);
    } catch {
      agentRows = [];
    }
  }

  const runsById = new Map<string, any>();
  const runsByIssueId = new Map<string, any>();
  for (const run of runRows) {
    if (run.id) runsById.set(run.id, run);
    if (run.contextIssueId) runsByIssueId.set(run.contextIssueId, run);
    if (run.nativeIssueId) runsByIssueId.set(run.nativeIssueId, run);
  }

  const agentsById = new Map<string, any>();
  for (const agent of agentRows) {
    if (agent.id) agentsById.set(agent.id, agent);
  }

  const stuckItems: StuckRunItem[] = [];

  for (const issue of issueRows) {
    const run =
      (issue.executionRunId && runsById.get(issue.executionRunId)) ||
      (issue.checkoutRunId && runsById.get(issue.checkoutRunId)) ||
      runsByIssueId.get(issue.id) ||
      null;

    const agentId = run?.agentId ?? issue.assigneeAgentId ?? "unknown";
    const agent = agentsById.get(agentId);

    const runActivity = run?.lastOutputAt ?? run?.updatedAt ?? run?.startedAt ?? run?.createdAt ?? null;
    const lastActivityDate = runActivity ?? issue.executionLockedAt ?? issue.updatedAt ?? null;
    const lastActivityMs = lastActivityDate ? new Date(lastActivityDate).getTime() : 0;

    const silenceMs = Math.max(0, nowMs - lastActivityMs);

    if (silenceMs >= timeoutMs) {
      const hasLock = Boolean(issue.executionLockedAt);
      const recommendation = determineRecoveryAction({
        silenceMs,
        timeoutMs,
        runStatus: run?.status ?? null,
        hasLock,
        agentStatus: agent?.status ?? null,
      });

      stuckItems.push({
        issueId: issue.id,
        taskId: issue.id,
        identifier: issue.identifier ?? null,
        title: issue.title ?? null,
        agentId,
        agent: agentId,
        runId: run?.id ?? null,
        runStatus: run?.status ?? null,
        silenceMs,
        silenceTime: silenceMs,
        silenceDurationMs: silenceMs,
        lastHeartbeatAt: lastActivityDate ? new Date(lastActivityDate).toISOString() : null,
        lastUpdatedAt: run?.updatedAt ? new Date(run.updatedAt).toISOString() : null,
        suggestedAction: recommendation.suggestedAction,
        action: recommendation.action,
        actionCode: recommendation.actionCode,
        reason: recommendation.reason,
      });
    }
  }

  const result = Object.assign([...stuckItems], {
    total: stuckItems.length,
    timeoutMs,
    runs: stuckItems,
    items: stuckItems,
  });

  return result as DetectStuckRunsResult;
}

/**
 * Executes the detect_stuck_runs tool without spawning any shell commands.
 */
export async function executeDetectStuckRuns(
  params?: DetectStuckRunsParams,
  options?: DetectStuckRunsOptions,
): Promise<DetectStuckRunsResult> {
  const timeoutMs =
    params?.timeoutMs ??
    (params?.timeoutSeconds !== undefined ? params.timeoutSeconds * 1000 : 300_000);
  const companyId = params?.companyId;

  // 1. If options.provider is provided, use it directly
  const provider = options?.provider ?? options?.metricsProvider;
  if (provider?.getStuckRuns) {
    const provided = await provider.getStuckRuns({ timeoutMs, companyId });
    if (Array.isArray(provided)) {
      return Object.assign([...provided], {
        total: provided.length,
        timeoutMs,
        runs: provided,
        items: provided,
      }) as DetectStuckRunsResult;
    }
    return provided as DetectStuckRunsResult;
  }

  // 2. If options.apiBaseUrl is provided, fetch via HTTP
  if (options?.apiBaseUrl) {
    const fetchFn = options.fetcher || globalThis.fetch;
    const url = new URL("/admin-assistant/stuck-runs", options.apiBaseUrl);
    if (timeoutMs) url.searchParams.set("timeoutMs", String(timeoutMs));
    if (companyId) url.searchParams.set("companyId", companyId);

    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.authToken) {
      headers["Authorization"] = `Bearer ${options.authToken}`;
    }

    try {
      const response = await fetchFn(url.toString(), { headers });
      if (response.ok) {
        const data = await response.json();
        const runs: StuckRunItem[] = Array.isArray(data) ? data : data.runs ?? [];
        return Object.assign([...runs], {
          total: runs.length,
          timeoutMs,
          runs,
          items: runs,
        }) as DetectStuckRunsResult;
      }
    } catch {
      // Fall through to database check or empty result
    }
  }

  // 3. If db is provided, query directly
  if (options?.db) {
    return detectStuckRuns(options.db, {
      timeoutMs,
      companyId,
      now: options.now,
    });
  }

  // Default empty result
  return Object.assign([], {
    total: 0,
    timeoutMs,
    runs: [],
    items: [],
  }) as DetectStuckRunsResult;
}

/**
 * Admin-assistant tool instance packaging schema definition and execution handler.
 */
export const detectStuckRunsTool = {
  name: DETECT_STUCK_RUNS_TOOL_NAME,
  definition: detectStuckRunsToolDefinition,
  schema: detectStuckRunsToolSchema,
  execute: executeDetectStuckRuns,
};
