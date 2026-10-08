import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import {
  INPUT_OVERFLOW_ERROR_FAMILY,
  classifyInputOverflow,
  type InputOverflowMatch,
} from "@paperclipai/adapter-utils/input-overflow";

/**
 * Provider input-overflow guard (OPE-6168, upstream #12023 family).
 *
 * "Input too long" is deterministic: the next identical attempt fails the same
 * way. The guard (1) recognises such a failed run, (2) lets the caller drop the
 * saved task session so the next attempt starts fresh (the adapter also gets a
 * new gateway session through `context.sessionGeneration`), and (3) after N
 * consecutive identical failures on one issue stops automatic retries and
 * raises an attention item with the facts.
 */

export const INPUT_OVERFLOW_MAX_FAILURES_ENV = "MYRMIDON_INPUT_OVERFLOW_MAX_FAILURES";
export const DEFAULT_INPUT_OVERFLOW_MAX_FAILURES = 3;

export function readInputOverflowMaxFailures(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[INPUT_OVERFLOW_MAX_FAILURES_ENV]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_INPUT_OVERFLOW_MAX_FAILURES;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 ? value : DEFAULT_INPUT_OVERFLOW_MAX_FAILURES;
}

interface OverflowRunShape {
  error?: string | null;
  errorCode?: string | null;
  resultJson?: Record<string, unknown> | null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Match by persisted family first, then by the provider wording. */
export function detectInputOverflowRun(run: OverflowRunShape): InputOverflowMatch | null {
  const result = run.resultJson ?? {};
  const textMatch = classifyInputOverflow(
    run.error,
    str(result.errorMessage),
    str(result.error),
  );
  if (textMatch) return textMatch;
  if (str(result.errorFamily) === INPUT_OVERFLOW_ERROR_FAMILY) {
    return { provider: "unknown", pattern: "errorFamily=input_overflow" };
  }
  return null;
}

export type InputOverflowDecision =
  | { action: "fresh_session"; consecutive: number; max: number }
  | { action: "stop"; consecutive: number; max: number };

export function decideInputOverflowAction(consecutive: number, max: number): InputOverflowDecision {
  return consecutive >= max
    ? { action: "stop", consecutive, max }
    : { action: "fresh_session", consecutive, max };
}

/**
 * Counts how many of the newest terminal runs of this agent on this issue are
 * input-overflow failures with no other outcome in between. Cancelled runs are
 * skipped; any other terminal run ends the streak.
 */
export async function countConsecutiveInputOverflowFailures(
  db: Pick<Db, "select">,
  input: { companyId: string; agentId: string; issueId: string; excludeRunId?: string; limit?: number },
): Promise<number> {
  const rows = await db
    .select({
      status: heartbeatRuns.status,
      error: heartbeatRuns.error,
      resultJson: sql<Record<string, unknown> | null>`jsonb_build_object('errorFamily', ${heartbeatRuns.resultJson} ->> 'errorFamily')`,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
        sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${input.issueId}`,
        sql`${heartbeatRuns.status} not in ('queued', 'running', 'cancelled')`,
        ...(input.excludeRunId ? [sql`${heartbeatRuns.id} <> ${input.excludeRunId}`] : []),
      ),
    )
    .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
    .limit(input.limit ?? 20);
  let streak = 0;
  for (const row of rows) {
    if (row.status === "failed" && detectInputOverflowRun(row)) streak += 1;
    else break;
  }
  return streak;
}

/** Session generation for the adapter: number of overflow failures recorded for this issue. */
export async function countInputOverflowFailures(
  db: Pick<Db, "select">,
  input: { companyId: string; agentId: string; issueId: string },
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
        sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${input.issueId}`,
        sql`${heartbeatRuns.resultJson} ->> 'errorFamily' = ${INPUT_OVERFLOW_ERROR_FAMILY}`,
      ),
    );
  return row?.count ?? 0;
}

export function buildInputOverflowAttentionComment(input: {
  match: InputOverflowMatch;
  consecutive: number;
  max: number;
  runId: string;
  errorExcerpt: string | null;
}): string {
  return [
    `Automatic retries stopped: ${input.consecutive} consecutive runs failed because the provider rejected the input as too long (limit ${input.max}).`,
    "",
    `- provider wording: ${input.match.provider} — \`${input.match.pattern}\``,
    `- last run: ${input.runId}`,
    input.errorExcerpt ? `- error: ${input.errorExcerpt}` : null,
    "",
    "Retrying without changes fails the same way. Reset or compact the agent session for this issue (run detail → reset task session), shorten the task context, or switch the model, then wake the agent again.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}
