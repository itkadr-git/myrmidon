// myrmidon(1.6-AUTONOMY): execute a held autonomy action after approval.
//
// `gate.holdOrAssert` records a held action as a `tool_invocations` row
// (`tool_name = autonomy_action_<class>`) plus a `tool_action_requests` row, and
// stores the descriptor it must replay later under
// `policy_explanation["myrmidon.autonomy"]`. When the board approves that request
// the descriptor is replayed on behalf of the original actor exactly once.
//
// Exactly-once is not a flag: the request is claimed with a conditional UPDATE
// (`approved` -> `executing`), and only the caller that actually flipped the row
// runs the action. A second approval, or a retry that finds the row no longer
// `approved`, claims nothing and does nothing.
//
// The module is deliberately free of server services: the real pause/resume/wake
// calls are injected as `AutonomyActionExecutors`, so the rule above is unit
// testable without a database or an agent runtime.

import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { toolActionRequests, toolInvocations } from "@paperclipai/db";

/** `tool_invocations.tool_name` prefix that marks a held autonomy action. */
export const AUTONOMY_ACTION_TOOL_PREFIX = "autonomy_action_";
/** Key the replay descriptor is stored under inside `policy_explanation`. */
export const AUTONOMY_DESCRIPTOR_KEY = "myrmidon.autonomy";

/** What `holdOrAssert` captured and what the executor replays. */
export interface AutonomyActionDescriptor {
  actionClass: string;
  route: string;
  method: string;
  params?: Record<string, unknown> | null;
  body?: Record<string, unknown> | null;
}

export interface AutonomyActionOrigin {
  actorType: string | null;
  actorId: string | null;
}

/** The real side effects, injected so the rule above stays testable. */
export interface AutonomyActionExecutors {
  pause(agentId: string): Promise<unknown>;
  resume(agentId: string): Promise<unknown>;
  wakeup(agentId: string): Promise<unknown>;
}

/** Built per held action so a replay can act as the original actor. */
export type AutonomyActionExecutorsFactory = (
  origin: AutonomyActionOrigin,
) => AutonomyActionExecutors;

export type AutonomyExecutionOutcome = "executed" | "skipped" | "failed";

export function autonomyToolName(actionClass: string): string {
  return `${AUTONOMY_ACTION_TOOL_PREFIX}${actionClass}`;
}

export function isAutonomyToolName(toolName: string | null | undefined): boolean {
  return typeof toolName === "string" && toolName.startsWith(AUTONOMY_ACTION_TOOL_PREFIX);
}

/** The columns `holdOrAssert` writes for a held action's invocation. */
export function autonomyDescriptorColumns(descriptor: AutonomyActionDescriptor) {
  const json = JSON.stringify(descriptor);
  const sha256 = createHash("sha256").update(json).digest("hex");
  return {
    hash: sha256,
    explanation: { [AUTONOMY_DESCRIPTOR_KEY]: descriptor } as Record<string, unknown>,
    summary: {
      summary: `Autonomy action ${descriptor.actionClass} for route ${descriptor.route}`,
      sizeBytes: Buffer.byteLength(json),
      sha256,
      redactedFields: [] as string[],
    },
  };
}

/** Read back the descriptor a held action was recorded with. */
export function readAutonomyDescriptor(
  explanation: unknown,
): AutonomyActionDescriptor | null {
  if (typeof explanation !== "object" || explanation === null) return null;
  const value = (explanation as Record<string, unknown>)[AUTONOMY_DESCRIPTOR_KEY];
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<AutonomyActionDescriptor>;
  if (
    typeof candidate.actionClass !== "string" ||
    typeof candidate.route !== "string" ||
    typeof candidate.method !== "string"
  ) {
    return null;
  }
  return {
    actionClass: candidate.actionClass,
    route: candidate.route,
    method: candidate.method,
    params: candidate.params ?? null,
    body: candidate.body ?? null,
  };
}

/**
 * The agent the action targets. The descriptor carries it explicitly when the
 * route supplied one; otherwise it is read from `/agents/:id/<verb>`.
 */
export function targetAgentId(descriptor: AutonomyActionDescriptor): string | null {
  const explicit = descriptor.params?.agentId;
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  const routeId = descriptor.route.match(/(?:^|\/)agents\/([^/?]+)/)?.[1];
  return routeId && routeId.length > 0 ? routeId : null;
}

async function runDescriptor(
  descriptor: AutonomyActionDescriptor,
  agentId: string,
  executors: AutonomyActionExecutors,
): Promise<void> {
  if (descriptor.actionClass !== "pause_wake_agents") {
    throw new Error(`Unsupported autonomy action class: ${descriptor.actionClass}`);
  }
  if (descriptor.route.includes("/pause")) {
    await executors.pause(agentId);
    return;
  }
  if (descriptor.route.includes("/resume")) {
    await executors.resume(agentId);
    return;
  }
  if (descriptor.route.includes("/wakeup")) {
    await executors.wakeup(agentId);
    return;
  }
  throw new Error(`Unsupported pause/wake/resume route: ${descriptor.route}`);
}

export interface ExecuteApprovedAutonomyActionInput {
  db: Db;
  actionRequestId: string;
  /** The actor that approved the request; recorded as the decider. */
  approvedBy: { userId?: string | null; agentId?: string | null };
  executors: AutonomyActionExecutorsFactory;
  now?: () => Date;
}

/**
 * Replay an approved held action on behalf of the original actor, at most once.
 * Returns `skipped` when the request is not an approved autonomy action or when
 * another caller already claimed it.
 */
export async function executeApprovedAutonomyAction(
  input: ExecuteApprovedAutonomyActionInput,
): Promise<AutonomyExecutionOutcome> {
  const { db, actionRequestId, approvedBy } = input;
  const now = input.now?.() ?? new Date();

  const [request] = await db
    .select()
    .from(toolActionRequests)
    .where(eq(toolActionRequests.id, actionRequestId))
    .limit(1);
  if (!request) {
    throw new Error(`Action request ${actionRequestId} not found`);
  }
  if (request.status !== "approved") return "skipped";

  const [invocation] = await db
    .select()
    .from(toolInvocations)
    .where(eq(toolInvocations.id, request.invocationId))
    .limit(1);
  if (!invocation) {
    throw new Error(`Invocation for action request ${actionRequestId} not found`);
  }
  if (!isAutonomyToolName(invocation.toolName)) return "skipped";

  const descriptor = readAutonomyDescriptor(invocation.policyExplanation);
  if (!descriptor) return "skipped";
  const agentId = targetAgentId(descriptor);
  if (!agentId) return "skipped";

  // The single claim that makes execution exactly-once.
  const claimed = await db
    .update(toolActionRequests)
    .set({ status: "executing", updatedAt: now })
    .where(
      and(
        eq(toolActionRequests.id, actionRequestId),
        eq(toolActionRequests.status, "approved"),
      ),
    )
    .returning({ id: toolActionRequests.id });
  if (claimed.length === 0) return "skipped";

  const decidedBy = approvedBy.userId ?? approvedBy.agentId ?? "board";
  const executors = input.executors({
    actorType: invocation.actorType ?? null,
    actorId: invocation.actorId ?? null,
  });
  try {
    await runDescriptor(descriptor, agentId, executors);
  } catch (error) {
    await finish(db, invocation.id, actionRequestId, "failed", decidedBy, now, error);
    return "failed";
  }
  await finish(db, invocation.id, actionRequestId, "executed", decidedBy, now, null);
  return "executed";
}

/**
 * The hook the review path calls after an approval commits. It answers
 * `not_autonomy` for every ordinary tool action, so a caller can invoke it
 * unconditionally and only pay two reads, and it never throws on a request that
 * is already settled — the claim above decides who runs.
 */
export async function replayHeldAutonomyAction(
  input: ExecuteApprovedAutonomyActionInput,
): Promise<AutonomyExecutionOutcome | "not_autonomy"> {
  const [request] = await input.db
    .select()
    .from(toolActionRequests)
    .where(eq(toolActionRequests.id, input.actionRequestId))
    .limit(1);
  if (!request) return "skipped";
  const [invocation] = await input.db
    .select()
    .from(toolInvocations)
    .where(eq(toolInvocations.id, request.invocationId))
    .limit(1);
  if (!invocation || !isAutonomyToolName(invocation.toolName)) return "not_autonomy";
  if (request.status !== "approved") return "skipped";
  return executeApprovedAutonomyAction(input);
}

async function finish(
  db: Db,
  invocationId: string,
  actionRequestId: string,
  status: "executed" | "failed",
  decidedBy: string,
  now: Date,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : error ? String(error) : null;
  await db
    .update(toolActionRequests)
    .set({
      status,
      resolvedByUserId: decidedBy,
      decidedByUserId: decidedBy,
      decidedAt: now,
      resolvedAt: now,
      updatedAt: now,
    })
    .where(eq(toolActionRequests.id, actionRequestId));
  await db
    .update(toolInvocations)
    .set({
      status: status === "executed" ? "succeeded" : "failed",
      completedAt: now,
      updatedAt: now,
      ...(message ? { errorCode: "autonomy_execution_failed", errorMessage: message } : {}),
    })
    .where(eq(toolInvocations.id, invocationId));
}