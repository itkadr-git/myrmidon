import { and, eq, gte, lt, sql } from "drizzle-orm";
import { heartbeatRuns, issueThreadInteractions, type Db } from "@myrmidon/db";

/**
 * A pending question card wakes its addressee even past the daily run limit.
 *
 * The daily run limit (`runtime_config.heartbeat.maxDailyRuns`) is meant to stop
 * runaway self-started work (idle pickup, timers). A wake with
 * `wakeReason: interaction_pending` is the opposite: another agent is blocked
 * until the addressee answers its card. Refusing it at the limit used to lose
 * the wake for good (a `skipped` receipt, no retry), and the card waited until
 * the UTC reset or longer.
 *
 * Why a bounded bypass and not `dailyRunLimitDeferral`: the deferral parks the
 * run until the UTC midnight reset, so a question asked early in the day could
 * wait up to 24 hours, far more than the 30 minutes a blocked engineer should
 * wait. The bypass admits the wake at once. It is capped per agent per UTC day
 * (`DEFAULT_MAX_DAILY_INTERACTION_WAKE_RUNS`, `heartbeat.maxDailyInteractionWakes`
 * overrides it) so a flood of cards cannot turn the bypass into an unlimited
 * budget; beyond the cap the wake falls back to the ordinary limit, and the
 * stale-card sweep wakes the addressee again later.
 *
 * Only the daily RUN limit is bypassed. The daily cost limit still applies.
 */

export const INTERACTION_PENDING_WAKE_REASON = "interaction_pending";
export const DEFAULT_MAX_DAILY_INTERACTION_WAKE_RUNS = 50;
export const MAX_DAILY_INTERACTION_WAKES_KEY = "maxDailyInteractionWakes";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The per-day bypass cap of an agent: the heartbeat policy value, else the default. */
export function resolveInteractionWakeBypassCap(heartbeat: Record<string, unknown>): number {
  const raw = heartbeat[MAX_DAILY_INTERACTION_WAKES_KEY];
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  return DEFAULT_MAX_DAILY_INTERACTION_WAKE_RUNS;
}

/** The card id an `interaction_pending` wake names, or null when the wake is of another kind. */
export function readInteractionPendingWakeCardId(input: {
  reason?: string | null;
  contextSnapshot?: Record<string, unknown> | null;
  payload?: Record<string, unknown> | null;
}): string | null {
  const context = input.contextSnapshot ?? {};
  const isPending =
    input.reason === INTERACTION_PENDING_WAKE_REASON || context.wakeReason === INTERACTION_PENDING_WAKE_REASON;
  if (!isPending) return null;
  const candidate = context.interactionId ?? input.payload?.interactionId;
  return typeof candidate === "string" && UUID_PATTERN.test(candidate) ? candidate : null;
}

/**
 * True when the wake may pass the daily RUN limit: its card is still pending
 * and addressed to this agent, and the agent has not used up the bypass cap in
 * the day window. `excludeRunId` is the run being claimed (already counted).
 */
export async function interactionWakeBypassesDailyRunLimit(
  db: Pick<Db, "select">,
  input: {
    companyId: string;
    agentId: string;
    cardId: string;
    cap: number;
    window: { start: Date; end: Date };
    excludeRunId?: string | null;
  },
): Promise<boolean> {
  if (input.cap <= 0) return false;
  const [card] = await db
    .select({ id: issueThreadInteractions.id })
    .from(issueThreadInteractions)
    .where(
      and(
        eq(issueThreadInteractions.id, input.cardId),
        eq(issueThreadInteractions.companyId, input.companyId),
        eq(issueThreadInteractions.status, "pending"),
        eq(issueThreadInteractions.addresseeAgentId, input.agentId),
      ),
    )
    .limit(1);
  if (!card) return false;
  const conditions = [
    eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.agentId, input.agentId),
    gte(heartbeatRuns.createdAt, input.window.start),
    lt(heartbeatRuns.createdAt, input.window.end),
    sql`${heartbeatRuns.contextSnapshot} ->> 'wakeReason' = ${INTERACTION_PENDING_WAKE_REASON}`,
    sql`${heartbeatRuns.status} <> 'cancelled'`,
  ];
  if (input.excludeRunId) conditions.push(sql`${heartbeatRuns.id} <> ${input.excludeRunId}`);
  const [row] = await db
    .select({ total: sql<number>`count(*)::integer` })
    .from(heartbeatRuns)
    .where(and(...conditions));
  return Number(row?.total ?? 0) < input.cap;
}
