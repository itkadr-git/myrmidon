import { and, eq } from "drizzle-orm";
import { issues, projects, type Db } from "@myrmidon/db";

// Opt-in per project: other board processes retain their existing release path.
export function devProcessProjectIds(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set((env.MYRMIDON_DEV_PROCESS_PROJECT_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean));
}

export type ReviewedIssue = {
  id: string;
  companyId: string;
  projectId: string | null;
  status: string;
  assigneeAgentId: string | null;
  executionState?: unknown;
};

export function issueAuthorAgentId(issue: ReviewedIssue): string | null {
  let state = issue.executionState;
  if (typeof state === "string") {
    try {
      state = JSON.parse(state);
    } catch {
      state = null;
    }
  }
  if (state && typeof state === "object") {
    const raw = state as Record<string, unknown>;
    const ret = raw.returnAssignee as { type?: string; agentId?: string | null } | null | undefined;
    if (ret && ret.type === "agent" && typeof ret.agentId === "string" && ret.agentId.trim().length > 0) {
      return ret.agentId.trim();
    }
  }
  return issue.assigneeAgentId;
}

export interface DevReviewContinuationPorts {
  match(agentId: string, options: { projectId: string; excludeIssueId: string }): Promise<{
    enabled: boolean;
    pair: { issueId: string } | null;
  }>;
  signalLead(issue: ReviewedIssue, agentId: string): Promise<void>;
}

/** Called after execution release, not during PATCH: the author is now free.
 * A handled dev release must never fall through to the company-wide picker.
 */
export async function continueDevReview(
  ports: DevReviewContinuationPorts,
  issue: ReviewedIssue | null,
  agentId: string,
  enabledProjects: ReadonlySet<string>,
): Promise<boolean> {
  if (!issue || issue.status !== "in_review") return false;
  const authorAgentId = issueAuthorAgentId(issue);
  if (!authorAgentId || authorAgentId !== agentId) return false;
  if (!issue.projectId || !enabledProjects.has(issue.projectId)) return false;

  const result = await ports.match(agentId, { projectId: issue.projectId, excludeIssueId: issue.id });
  // Disabled/admission failures are not evidence that the queue is empty.
  if (result.enabled && !result.pair) await ports.signalLead(issue, agentId);
  return true;
}

export interface DevReviewWakeupOptions {
  source?: "timer" | "assignment" | "on_demand" | "automation";
  triggerDetail?: "manual" | "ping" | "callback" | "system";
  reason?: string | null;
  idempotencyKey?: string | null;
  payload?: Record<string, unknown> | null;
  contextSnapshot?: Record<string, unknown>;
}

export type DevReviewEnqueueWakeup = (
  agentId: string,
  options?: DevReviewWakeupOptions,
  executionWaitRequestId?: string,
) => Promise<unknown>;

export interface DevReviewReleaseContext {
  db: Db;
  releasedRun: {
    id: string;
    agentId: string;
    companyId: string;
    contextSnapshot?: unknown;
  };
  currentRunId: string;
  match: (agentId: string, scope: { projectId: string; excludeIssueId: string }) => Promise<{
    enabled: boolean;
    pair: { issueId: string } | null;
  }>;
  enqueueWakeup: DevReviewEnqueueWakeup;
  logActivity?: (db: Db, input: {
    companyId: string;
    actorType: "system";
    actorId: string;
    agentId: string;
    runId: string;
    action: string;
    entityType: string;
    entityId: string;
    details: Record<string, unknown>;
  }) => Promise<unknown>;
  enabledProjects?: ReadonlySet<string>;
}

export async function tryDevReviewContinuationOnRelease(ctx: DevReviewReleaseContext): Promise<boolean> {
  const enabledProjects = ctx.enabledProjects ?? devProcessProjectIds();
  if (enabledProjects.size === 0) return false;

  const snapshot = typeof ctx.releasedRun.contextSnapshot === "object" && ctx.releasedRun.contextSnapshot !== null
    ? (ctx.releasedRun.contextSnapshot as Record<string, unknown>)
    : null;
  const rawIssueId = snapshot?.issueId;
  const releasedIssueId = typeof rawIssueId === "string" && rawIssueId.trim().length > 0 ? rawIssueId.trim() : null;
  if (!releasedIssueId) return false;

  const [releasedIssue] = await ctx.db.select().from(issues)
    .where(and(eq(issues.id, releasedIssueId), eq(issues.companyId, ctx.releasedRun.companyId))).limit(1);
  if (!releasedIssue) return false;

  return continueDevReview({
    match: ctx.match,
    signalLead: async (source, engineerId) => {
      const [project] = await ctx.db.select({ leadAgentId: projects.leadAgentId }).from(projects)
        .where(and(eq(projects.id, source.projectId!), eq(projects.companyId, source.companyId))).limit(1);
      if (ctx.logActivity) {
        await ctx.logActivity(ctx.db, {
          companyId: source.companyId, actorType: "system", actorId: "dev_review_continuation",
          agentId: engineerId, runId: ctx.currentRunId, action: "dev_project.queue_unavailable",
          entityType: "issue", entityId: source.id,
          details: { projectId: source.projectId, engineerId, leadAgentId: project?.leadAgentId ?? null },
        });
      }
      if (!project?.leadAgentId || project.leadAgentId === engineerId) return;
      await ctx.enqueueWakeup(project.leadAgentId, {
        source: "automation", triggerDetail: "system", reason: "dev_project_queue_empty",
        idempotencyKey: `dev-review-empty:${ctx.currentRunId}`,
        payload: { issueId: source.id, projectId: source.projectId, engineerId },
        contextSnapshot: {
          issueId: source.id, projectId: source.projectId, engineerId,
          wakeReason: "dev_project_queue_empty",
          message: "Инженер сдал задачу на ревью; следующая доступная задача dev-проекта не подобрана. Проверьте очередь и ограничения допуска.",
        },
      });
    },
  }, releasedIssue, ctx.releasedRun.agentId, enabledProjects);
}
