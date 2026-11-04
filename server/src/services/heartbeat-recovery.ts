import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { agents, heartbeatRuns, issues } from "@myrmidon/db";

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

export interface DetectStuckRunsOptions {
  timeoutMs?: number;
  timeoutSeconds?: number;
  companyId?: string;
  now?: Date;
}

/**
 * Searches for in_progress tasks whose heartbeat run has not updated longer than timeoutMs,
 * and compiles recovery recommendations.
 */
export async function detectStuckRuns(
  db: Db,
  options?: DetectStuckRunsOptions,
): Promise<DetectStuckRunsResult> {
  const timeoutMs =
    options?.timeoutMs ??
    (options?.timeoutSeconds !== undefined ? options.timeoutSeconds * 1000 : 300_000);
  const companyId = options?.companyId;
  const now = options?.now ?? new Date();
  const nowMs = now.getTime();

  // 1. Fetch in_progress issues
  const issueConditions = [
    eq(issues.status, "in_progress"),
    isNull(issues.hiddenAt),
  ];
  if (companyId) {
    issueConditions.push(eq(issues.companyId, companyId));
  }

  let issueRows: Array<{
    id: string;
    identifier: string | null;
    title: string | null;
    status: string;
    assigneeAgentId: string | null;
    executionRunId: string | null;
    checkoutRunId: string | null;
    executionLockedAt: Date | null;
    updatedAt: Date | null;
    companyId: string;
  }> = [];

  try {
    issueRows = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        executionRunId: issues.executionRunId,
        checkoutRunId: issues.checkoutRunId,
        executionLockedAt: issues.executionLockedAt,
        updatedAt: issues.updatedAt,
        companyId: issues.companyId,
      })
      .from(issues)
      .where(and(...issueConditions));
  } catch {
    issueRows = [];
  }

  if (issueRows.length === 0) {
    return Object.assign([], {
      total: 0,
      timeoutMs,
      runs: [],
      items: [],
    }) as DetectStuckRunsResult;
  }

  // 2. Fetch heartbeat runs
  const runIds = Array.from(
    new Set(
      issueRows
        .flatMap((row) => [row.executionRunId, row.checkoutRunId])
        .filter((id): id is string => Boolean(id)),
    ),
  );

  let runRows: Array<{
    id: string;
    agentId: string;
    status: string;
    startedAt: Date | null;
    lastOutputAt: Date | null;
    updatedAt: Date | null;
    createdAt: Date | null;
    contextIssueId?: string | null;
  }> = [];

  try {
    if (runIds.length > 0) {
      runRows = await db
        .select({
          id: heartbeatRuns.id,
          agentId: heartbeatRuns.agentId,
          status: heartbeatRuns.status,
          startedAt: heartbeatRuns.startedAt,
          lastOutputAt: heartbeatRuns.lastOutputAt,
          updatedAt: heartbeatRuns.updatedAt,
          createdAt: heartbeatRuns.createdAt,
          contextIssueId: heartbeatRuns.contextIssueId,
        })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.id, runIds));
    } else {
      runRows = await db
        .select({
          id: heartbeatRuns.id,
          agentId: heartbeatRuns.agentId,
          status: heartbeatRuns.status,
          startedAt: heartbeatRuns.startedAt,
          lastOutputAt: heartbeatRuns.lastOutputAt,
          updatedAt: heartbeatRuns.updatedAt,
          createdAt: heartbeatRuns.createdAt,
          contextIssueId: heartbeatRuns.contextIssueId,
        })
        .from(heartbeatRuns);
    }
  } catch {
    runRows = [];
  }

  // 3. Fetch agents status for error detection
  const agentIds = Array.from(
    new Set(
      [
        ...issueRows.map((i) => i.assigneeAgentId),
        ...runRows.map((r) => r.agentId),
      ].filter((id): id is string => Boolean(id)),
    ),
  );

  const agentsById = new Map<string, { id: string; status: string }>();
  try {
    if (agentIds.length > 0) {
      const agentRows = await db
        .select({
          id: agents.id,
          status: agents.status,
        })
        .from(agents)
        .where(inArray(agents.id, agentIds));
      for (const a of agentRows) {
        agentsById.set(a.id, a);
      }
    }
  } catch {
    // ignore
  }

  // 4. Map runs and evaluate stuck status
  const runsById = new Map<string, (typeof runRows)[number]>();
  const runsByIssueId = new Map<string, (typeof runRows)[number]>();
  for (const run of runRows) {
    if (run.id) runsById.set(run.id, run);
    if (run.contextIssueId) runsByIssueId.set(run.contextIssueId, run);
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
