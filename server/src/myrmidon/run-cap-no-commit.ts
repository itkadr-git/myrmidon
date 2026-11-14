import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import {
  activityLog,
  agents,
  heartbeatRuns,
  instanceSettings,
  issueWorkProducts,
  projects,
} from "@myrmidon/db";

export const RUN_CAP_NO_COMMIT_REASON = "runs_without_commit_limit_reached";
export const RUN_CAP_NO_COMMIT_BLOCK_REASON = "human_decision";
export const RUN_CAP_NO_COMMIT_UNBLOCK_ACTION = "runs_without_commit_cap_released";

export const TASK_RUNS_WITHOUT_COMMIT_LIMIT_KEY = "taskRunsWithoutCommitLimit";
export const DEFAULT_TASK_RUNS_WITHOUT_COMMIT_LIMIT = 4;
const DEFAULT_SINGLETON_KEY = "default";

function readProcessesRecord(general: unknown): Record<string, unknown> | null {
  if (!general || typeof general !== "object" || Array.isArray(general)) return null;
  const processes = (general as Record<string, unknown>).processes;
  if (!processes || typeof processes !== "object" || Array.isArray(processes)) return null;
  return processes as Record<string, unknown>;
}

export function resolveTaskRunsWithoutCommitLimit(general: unknown): number {
  const processes = readProcessesRecord(general);
  const raw = processes?.[TASK_RUNS_WITHOUT_COMMIT_LIMIT_KEY];
  const numeric =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim() !== ""
        ? Number(raw)
        : Number.NaN;
  if (!Number.isFinite(numeric)) return DEFAULT_TASK_RUNS_WITHOUT_COMMIT_LIMIT;
  const rounded = Math.round(numeric);
  if (rounded <= 0) return 0;
  return Math.min(100, rounded);
}

export async function loadTaskRunsWithoutCommitLimit(db: Db): Promise<number> {
  try {
    const [row] = await db
      .select({ general: instanceSettings.general })
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, DEFAULT_SINGLETON_KEY))
      .limit(1);
    return resolveTaskRunsWithoutCommitLimit(row?.general ?? {});
  } catch {
    return DEFAULT_TASK_RUNS_WITHOUT_COMMIT_LIMIT;
  }
}

export const ACTIONABLE_RUN_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
] as const;

export type RunCommitObservation = {
  runId: string;
  status: string;
  headSha: string | null;
  createdAt: Date;
  summary?: string | null;
  error?: string | null;
};

export type RunCapNoCommitStop = {
  companyId: string;
  issueId: string;
  projectId?: string | null;
  agentId: string;
  count: number;
  limit: number;
  headSha: string;
  lastSummaries: string[];
};

/**
 * Counts consecutive completed runs by the assignee for this task where the PR headSha did not change.
 * If any run in the sequence had a different headSha, the counter resets.
 * If headSha is null (no PR associated with run), the cap does not trigger.
 * If a resetAfter timestamp is given (e.g. manual unblock), runs on or before it do not count.
 */
export function countRunsWithoutCommit(
  runs: RunCommitObservation[],
  currentHeadSha: string | null,
  options?: { resetAfter?: Date | null },
): { count: number; lastSummaries: string[] } {
  if (!currentHeadSha) {
    return { count: 0, lastSummaries: [] };
  }

  const resetTime = options?.resetAfter?.getTime() ?? Number.NEGATIVE_INFINITY;
  let count = 0;
  const lastSummaries: string[] = [];

  for (const run of runs) {
    if (run.createdAt.getTime() <= resetTime) {
      break;
    }
    // Only count runs with recorded headSha matching the current headSha
    if (run.headSha !== currentHeadSha) {
      break;
    }
    count++;
    const summary = run.summary || run.error || `Run ${run.runId} (${run.status})`;
    lastSummaries.push(summary);
  }

  return { count, lastSummaries };
}

export function buildRunCapNoCommitBlockedPatch(input: {
  agentId: string;
  count: number;
  limit: number;
  headSha: string;
  now?: Date;
}) {
  const nextCheckAt = new Date((input.now ?? new Date()).getTime() + 24 * 60 * 60 * 1000);
  return {
    status: "blocked" as const,
    blockerMetadata: {
      owner: { agentId: input.agentId },
      blockReason: RUN_CAP_NO_COMMIT_BLOCK_REASON,
      externalRef: `run_cap_no_commit:${input.headSha}:${input.count}`,
      nextCheckAt: nextCheckAt.toISOString(),
      timeoutAt: nextCheckAt.toISOString(),
      escalationPolicy: "escalate_to_manager" as const,
    },
    unblockDescriptor: {
      owner: { agentId: input.agentId },
      action: RUN_CAP_NO_COMMIT_UNBLOCK_ACTION,
    },
  };
}

export function buildRunCapNoCommitComment(input: {
  count: number;
  limit: number;
  headSha: string;
  lastSummaries: string[];
}): string {
  const shortSha = input.headSha.slice(0, 8);
  const summaryLines = input.lastSummaries.slice(0, 4).map((s) => `- ${s}`).join("\n");
  return `Автоматическая остановка: задача достигла потолка ${input.count} прогонов без нового коммита (голова PR: ${shortSha}).\n\nПоследние итоги прогонов:\n${summaryLines}\n\nСчётчик сбрасывается при новом коммите в ветке или ручном снятии блока.`;
}

export function extractRunHeadSha(run: typeof heartbeatRuns.$inferSelect): string | null {
  const contextSnapshot = run.contextSnapshot as Record<string, any> | null;
  if (!contextSnapshot) return null;

  // 1. Direct record in contextSnapshot (written at finish or in wake context)
  if (typeof contextSnapshot.prHeadSha === "string" && contextSnapshot.prHeadSha.trim()) {
    return contextSnapshot.prHeadSha.trim();
  }

  // 2. Check resultJson if present
  const resultJson = run.resultJson as Record<string, any> | null;
  if (resultJson && typeof resultJson.prHeadSha === "string" && resultJson.prHeadSha.trim()) {
    return resultJson.prHeadSha.trim();
  }

  // 3. Fallback to wake payload pullRequestsCi
  const wake = contextSnapshot.paperclipWake as Record<string, any> | null;
  if (wake && Array.isArray(wake.pullRequestsCi) && wake.pullRequestsCi.length > 0) {
    const sha = wake.pullRequestsCi[0]?.headSha;
    if (typeof sha === "string" && sha.trim()) {
      return sha.trim();
    }
  }

  return null;
}

export function extractRunSummary(run: typeof heartbeatRuns.$inferSelect): string | null {
  const resultJson = run.resultJson as Record<string, any> | null;
  if (resultJson) {
    if (typeof resultJson.summary === "string" && resultJson.summary.trim()) {
      return resultJson.summary.trim();
    }
    if (typeof resultJson.resultSummary === "string" && resultJson.resultSummary.trim()) {
      return resultJson.resultSummary.trim();
    }
  }
  const contextSnapshot = run.contextSnapshot as Record<string, any> | null;
  if (contextSnapshot && typeof contextSnapshot.summary === "string" && contextSnapshot.summary.trim()) {
    return contextSnapshot.summary.trim();
  }
  return run.error ?? null;
}

export async function readTaskCurrentHeadSha(
  db: Db,
  companyId: string,
  issueId: string,
): Promise<string | null> {
  const products = await db
    .select({
      metadata: issueWorkProducts.metadata,
    })
    .from(issueWorkProducts)
    .where(
      and(
        eq(issueWorkProducts.companyId, companyId),
        eq(issueWorkProducts.issueId, issueId),
        eq(issueWorkProducts.type, "pull_request"),
      ),
    )
    .orderBy(desc(issueWorkProducts.createdAt))
    .limit(1);

  if (products.length === 0) return null;
  const meta = products[0].metadata as Record<string, any> | null;
  if (meta && typeof meta.headSha === "string" && meta.headSha.trim()) {
    return meta.headSha.trim();
  }
  return null;
}

export async function readLatestManualUnblockAt(
  db: Db,
  companyId: string,
  issueId: string,
): Promise<Date | null> {
  const [act] = await db
    .select({ createdAt: activityLog.createdAt, details: activityLog.details })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, issueId),
        eq(activityLog.action, "issue.updated"),
        or(
          eq(activityLog.actorType, "user"),
          sql`${activityLog.details}->>'previousStatus' = 'blocked'`,
        ),
      ),
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(1);

  return act?.createdAt ?? null;
}

export async function readRunCapNoCommitHistory(
  db: Db,
  companyId: string,
  issueId: string,
  assigneeAgentId: string,
  limit: number = 20,
): Promise<RunCommitObservation[]> {
  const rows = await db
    .select()
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.agentId, assigneeAgentId),
        inArray(heartbeatRuns.status, [...ACTIONABLE_RUN_STATUSES]),
        sql`(${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId} or ${heartbeatRuns.contextSnapshot}->'_paperclipWakeContext'->>'issueId' = ${issueId})`,
      ),
    )
    .orderBy(desc(heartbeatRuns.createdAt))
    .limit(limit);

  // Filter out maintenance runs
  const filtered = rows.filter((r: typeof heartbeatRuns.$inferSelect) => {
    const wake = (r.contextSnapshot as Record<string, any> | null)?.paperclipWake;
    const reason = wake?.reason || (r.contextSnapshot as Record<string, any> | null)?.triggerReason;
    if (typeof reason === "string" && reason.startsWith("myrmidon_maintenance_")) {
      return false;
    }
    return true;
  });

  return filtered.map((r: typeof heartbeatRuns.$inferSelect) => ({
    runId: r.id,
    status: r.status,
    headSha: extractRunHeadSha(r),
    createdAt: r.createdAt,
    summary: extractRunSummary(r),
    error: r.error,
  }));
}

export async function resolveRunCapNoCommitWakeTargetId(
  db: Db,
  input: {
    companyId: string;
    projectId?: string | null;
    assigneeAgentId?: string | null;
  },
): Promise<string | null> {
  // 1. If task belongs to a project with leadAgentId, wake project lead
  if (input.projectId) {
    const [project] = await db
      .select({ leadAgentId: projects.leadAgentId })
      .from(projects)
      .where(and(eq(projects.companyId, input.companyId), eq(projects.id, input.projectId)))
      .limit(1);
    if (project?.leadAgentId) {
      return project.leadAgentId;
    }
  }

  // 2. If assignee has reportsTo, wake reportsTo
  if (input.assigneeAgentId) {
    const [assignee] = await db
      .select({ reportsTo: agents.reportsTo })
      .from(agents)
      .where(and(eq(agents.companyId, input.companyId), eq(agents.id, input.assigneeAgentId)))
      .limit(1);
    if (assignee?.reportsTo) {
      return assignee.reportsTo;
    }
  }

  // 3. Fallback to adm agent
  const [admAgent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, input.companyId),
        sql`lower(${agents.name}) = 'adm' or lower(${agents.name}) like 'adm-%'`,
      ),
    )
    .limit(1);

  return admAgent?.id ?? null;
}
