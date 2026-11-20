import { and, asc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  agentWakeupRequests,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
  type Db,
} from "@myrmidon/db";
import { logger } from "../middleware/logger.js";

/**
 * Stale pending card re-wake sweep (INTERACTION-WAKES-DAILY-LIMIT).
 *
 * The wake that tells an addressee about a new question card is sent once, at
 * creation. When it is lost (the agent's daily run limit, a refused admission,
 * a run that died before it read the card) nothing sends it again, and the
 * engineer who asked waits. This sweep is the safety net on the scheduler tick:
 * a card that is still `pending` for an agent after `STALE_INTERACTION_WAKE_MS`
 * is announced to that agent again when
 *
 * - the addressee has no live run on the card's task or for the card, and
 * - no wake naming the card is in flight (queued or parked: the other sweep
 *   and the release drain own those), and
 * - no wake naming the card was requested in the last `STALE_INTERACTION_WAKE_MS`
 *   (any outcome, `skipped` included): this is the rate limit, at most one
 *   re-wake per card per 30 minutes.
 *
 * The re-wake carries the same context as the creation wake, so the staleness
 * gate and the daily-limit bypass treat it exactly like it.
 */

export const STALE_INTERACTION_WAKE_MS = 30 * 60 * 1000;
export const STALE_INTERACTION_WAKE_PAGE_SIZE = 50;
export const STALE_INTERACTION_REWAKE_IDEMPOTENCY_PREFIX = "interaction-stale-rewake:";
export const STALE_INTERACTION_REWAKE_PAYLOAD_KEY = "staleInteractionRewake";

const LIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
const IN_FLIGHT_WAKE_STATUSES = ["queued", "deferred_issue_execution"] as const;
const TERMINAL_ISSUE_STATUSES = ["done", "cancelled"] as const;

export type StaleInteractionRewake = {
  companyId: string;
  agentId: string;
  issueId: string;
  interactionId: string;
  interactionKind: string;
  sourceCommentId: string | null;
  sourceRunId: string | null;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  contextSnapshot: Record<string, unknown>;
};

export interface StaleInteractionRewakeSweepDeps {
  db: Db;
  /** Delivers the wake through the ordinary wake admission. */
  rewake: (wake: StaleInteractionRewake) => Promise<void>;
}

export interface StaleInteractionRewakeSweepResult {
  inspected: number;
  rewoken: number;
  skippedLiveRun: number;
  skippedWakeRecent: number;
  skippedIssueClosed: number;
  failed: number;
}

/** The wake a stale card gets: the creation wake's shape plus the sweep marker. */
export function buildStaleInteractionRewake(
  card: {
    id: string;
    companyId: string;
    issueId: string;
    kind: string;
    addresseeAgentId: string;
    sourceCommentId: string | null;
    sourceRunId: string | null;
  },
  now: Date,
  staleMs = STALE_INTERACTION_WAKE_MS,
): StaleInteractionRewake {
  return {
    companyId: card.companyId,
    agentId: card.addresseeAgentId,
    issueId: card.issueId,
    interactionId: card.id,
    interactionKind: card.kind,
    sourceCommentId: card.sourceCommentId,
    sourceRunId: card.sourceRunId,
    idempotencyKey: `${STALE_INTERACTION_REWAKE_IDEMPOTENCY_PREFIX}${card.id}:${Math.floor(now.getTime() / staleMs)}`,
    payload: {
      issueId: card.issueId,
      interactionId: card.id,
      interactionKind: card.kind,
      sourceCommentId: card.sourceCommentId,
      sourceRunId: card.sourceRunId,
      mutation: "interaction",
      [STALE_INTERACTION_REWAKE_PAYLOAD_KEY]: { at: now.toISOString() },
    },
    // Same context as the creation wake: the staleness gate recognises it.
    contextSnapshot: {
      issueId: card.issueId,
      taskId: card.issueId,
      interactionId: card.id,
      interactionKind: card.kind,
      sourceCommentId: card.sourceCommentId,
      sourceRunId: card.sourceRunId,
      wakeReason: "interaction_pending",
      source: "issue.interaction.created",
    },
  };
}

export function createStaleInteractionRewakeSweep(deps: StaleInteractionRewakeSweepDeps) {
  return async function sweepStaleInteractionRewakes(opts?: {
    now?: Date;
    staleMs?: number;
    limit?: number;
  }): Promise<StaleInteractionRewakeSweepResult> {
    const now = opts?.now ?? new Date();
    const staleMs = opts?.staleMs ?? STALE_INTERACTION_WAKE_MS;
    const limit = Math.max(1, Math.min(opts?.limit ?? STALE_INTERACTION_WAKE_PAGE_SIZE, 500));
    const cutoff = new Date(now.getTime() - staleMs);

    const cards = await deps.db
      .select({
        id: issueThreadInteractions.id,
        companyId: issueThreadInteractions.companyId,
        issueId: issueThreadInteractions.issueId,
        kind: issueThreadInteractions.kind,
        addresseeAgentId: issueThreadInteractions.addresseeAgentId,
        sourceCommentId: issueThreadInteractions.sourceCommentId,
        sourceRunId: issueThreadInteractions.sourceRunId,
      })
      .from(issueThreadInteractions)
      .where(
        and(
          eq(issueThreadInteractions.status, "pending"),
          sql`${issueThreadInteractions.addresseeAgentId} is not null`,
          lte(issueThreadInteractions.createdAt, cutoff),
        ),
      )
      .orderBy(asc(issueThreadInteractions.createdAt))
      .limit(limit);

    const result: StaleInteractionRewakeSweepResult = {
      inspected: 0,
      rewoken: 0,
      skippedLiveRun: 0,
      skippedWakeRecent: 0,
      skippedIssueClosed: 0,
      failed: 0,
    };

    for (const card of cards) {
      result.inspected += 1;
      try {
        const agentId = card.addresseeAgentId!;
        const [issue] = await deps.db
          .select({ status: issues.status })
          .from(issues)
          .where(and(eq(issues.id, card.issueId), eq(issues.companyId, card.companyId)))
          .limit(1);
        if (!issue || (TERMINAL_ISSUE_STATUSES as readonly string[]).includes(issue.status)) {
          result.skippedIssueClosed += 1;
          continue;
        }

        const [liveRun] = await deps.db
          .select({ id: heartbeatRuns.id })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.companyId, card.companyId),
              eq(heartbeatRuns.agentId, agentId),
              inArray(heartbeatRuns.status, [...LIVE_RUN_STATUSES]),
              isNull(heartbeatRuns.finishedAt),
              or(
                sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${card.issueId}`,
                sql`${heartbeatRuns.contextSnapshot} ->> 'interactionId' = ${card.id}`,
              ),
            ),
          )
          .limit(1);
        if (liveRun) {
          result.skippedLiveRun += 1;
          continue;
        }

        const [recentWake] = await deps.db
          .select({ id: agentWakeupRequests.id })
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.companyId, card.companyId),
              eq(agentWakeupRequests.agentId, agentId),
              sql`${agentWakeupRequests.payload} ->> 'interactionId' = ${card.id}`,
              or(
                gte(agentWakeupRequests.requestedAt, cutoff),
                inArray(agentWakeupRequests.status, [...IN_FLIGHT_WAKE_STATUSES]),
              ),
            ),
          )
          .limit(1);
        if (recentWake) {
          result.skippedWakeRecent += 1;
          continue;
        }

        await deps.rewake(buildStaleInteractionRewake({ ...card, addresseeAgentId: agentId }, now, staleMs));
        result.rewoken += 1;
      } catch {
        // Constant errorKind only: an exception message can carry a credential.
        result.failed += 1;
        logger.warn(
          { errorKind: "stale_interaction_rewake_failed", interactionId: card.id },
          "stale pending interaction re-wake failed for one card",
        );
      }
    }
    return result;
  };
}
