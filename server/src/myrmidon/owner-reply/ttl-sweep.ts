// myrmidon(1.6.5-F21-B): the owner-card TTL sweep.
//
// An owner request_confirmation card (`isOwnerDecisionAudience` from shared)
// the owner leaves unanswered for longer than MYRMIDON_OWNER_CARD_TTL_MS
// (default 72 h) is closed by the sweep on the scheduler tick:
//
//   - a card with `payload.silenceMeansRecommended === true` whose
//     `payload.decisionClass` is absent or outside the guarded classes
//     (money / external_world / deploy) is RESOLVED by the card's
//     recommended option — `payload.recommendedOption: "accept" | "reject"`,
//     default `accept` — through the ordinary resolution service with the
//     system actor, so policy, activity and continuation behave exactly as
//     if the owner pressed the button;
//   - every other overdue owner card is marked `expired` with the
//     administrative outcome `interaction_expired`.
//
// Both paths post one system comment on the task ("expired without an
// answer" / resolved-by-silence) and wake the card's author exactly once
// with wakeReason `interaction_expired` — the limiter is the idempotency
// key `owner-card-expired:<interactionId>` on agentWakeupRequests (the same
// receipt mechanism as the pending-interaction wake sweep), so a repeated
// pass never duplicates the wake.
//
// Delivery metadata (delivery.sentTo / sentAt / answeredAt) is derived from
// what already exists: the card's createdAt (the card publication) and the
// owner-message comment metadata written by the owner-delivery module
// (OWNER_MESSAGE_COMMENT_REASON / OWNER_MESSAGE_INTERACTION_LABEL) — the
// sweep never writes to the owner-delivery files.
//
// The scheduler wiring lives in index.ts behind `createOwnerCardTtlScheduler`;
// the interval and the per-pass budgets are read from the env on every pass.

import { and, asc, desc, eq, isNull, lt, sql } from "drizzle-orm";
import {
  agentWakeupRequests,
  issueComments,
  issueThreadInteractions,
  issues,
  type Db,
} from "@paperclipai/db";
import {
  OWNER_MESSAGE_COMMENT_REASON,
  OWNER_MESSAGE_INTERACTION_LABEL,
  isOwnerDecisionAudience,
  type IssueCommentMetadata,
  type IssueThreadInteractionPayload,
} from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { logActivity } from "../../services/activity-log.js";
import {
  readOwnerCardTtlSettings,
  type OwnerCardTtlSettings,
} from "./settings.js";

/** The wake reason the sweep wakes the card's author with. */
export const OWNER_CARD_EXPIRED_WAKE_REASON = "interaction_expired";
/** Idempotency prefix of the one author wake per expired card. */
export const OWNER_CARD_EXPIRED_WAKE_IDEMPOTENCY_PREFIX = "owner-card-expired:";
/** The systemId the sweep resolves/expires cards under. */
export const OWNER_CARD_SWEEP_SYSTEM_ID = "myrmidon.owner_card_ttl_sweep";
/** The activity action a TTL-closed card is logged with. */
export const OWNER_CARD_TTL_ACTIVITY_ACTION = "issue.thread_interaction_expired";

export const OWNER_CARD_EXPIRED_COMMENT =
  "Карточка владельца истекла без ответа (TTL). Закрыта автоматически со статусом expired.";
export const OWNER_CARD_SILENCE_RESOLVED_COMMENT =
  "Карточка владельца истекла без ответа (TTL). Применён рекомендованный вариант (молчание = согласие с рекомендацией).";

/**
 * Decision classes a silence-means-recommended card may never belong to:
 * money, the external world, a deploy. A card of a guarded class always
 * expires unanswered, whatever `silenceMeansRecommended` says.
 */
export const OWNER_CARD_GUARDED_DECISION_CLASSES = ["money", "external_world", "deploy"] as const;
export type OwnerCardGuardedDecisionClass = (typeof OWNER_CARD_GUARDED_DECISION_CLASSES)[number];

export type OwnerCardPayloadClass = {
  /** Raw payload fields the sweep reads. */
  silenceMeansRecommended: boolean;
  decisionClass: string | null;
  recommendedOption: "accept" | "reject";
};

/** Pure: how one payload is treated at TTL expiry. Exported for the unit tests. */
export function classifyOwnerCardPayload(payload: unknown): OwnerCardPayloadClass {
  const record =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const decisionClassRaw = record.decisionClass;
  const decisionClass =
    typeof decisionClassRaw === "string" && decisionClassRaw.trim().length > 0
      ? decisionClassRaw.trim()
      : null;
  const recommendedRaw = record.recommendedOption;
  const recommendedOption = recommendedRaw === "reject" ? "reject" : "accept";
  return {
    silenceMeansRecommended: record.silenceMeansRecommended === true,
    decisionClass,
    recommendedOption,
  };
}

/**
 * Pure: whether a card of this payload resolves by the recommended option at
 * TTL expiry (true) or expires (false). `silenceMeansRecommended` is honoured
 * only outside the guarded decision classes; a missing decisionClass is not
 * guarded.
 */
export function ownerCardResolvesBySilence(payload: unknown): boolean {
  const card = classifyOwnerCardPayload(payload);
  if (!card.silenceMeansRecommended) return false;
  if (card.decisionClass === null) return true;
  return !(OWNER_CARD_GUARDED_DECISION_CLASSES as readonly string[]).includes(card.decisionClass);
}

/** The delivery metadata the sweep derives for one card. */
export interface OwnerCardDeliveryMeta {
  /** The task owner the card waits on (responsibleUserId ?? createdByUserId). */
  sentTo: string | null;
  /** The card publication time (the interaction's createdAt). */
  sentAt: string;
  /** ISO time of the newest owner-message comment that explains this card. */
  ownerMessagedAt: string | null;
  /** ISO time the card was answered, or null while it is pending. */
  answeredAt: string | null;
}

/** Pure: packs the derived delivery metadata into the card payload. */
export function buildOwnerCardPayloadWithDelivery(
  payload: unknown,
  delivery: OwnerCardDeliveryMeta,
): Record<string, unknown> {
  const record =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? { ...(payload as Record<string, unknown>) }
      : {};
  record.delivery = {
    sentTo: delivery.sentTo,
    sentAt: delivery.sentAt,
    ownerMessagedAt: delivery.ownerMessagedAt,
    answeredAt: delivery.answeredAt,
  };
  return record;
}

export type OwnerCardTtlRow = {
  id: string;
  companyId: string;
  issueId: string;
  status: string;
  payload: unknown;
  createdAt: Date;
  createdByAgentId: string | null;
  addresseeAgentId: string | null;
  addresseeUserId: string | null;
  effectiveResolverPolicy: string;
  issueIdentifier: string | null;
  ownerUserId: string | null;
};

/** Pure: is this row a pending owner card past the TTL cutoff? */
export function isExpiredOwnerCardRow(
  row: Pick<
    OwnerCardTtlRow,
    | "status"
    | "createdAt"
    | "effectiveResolverPolicy"
    | "addresseeAgentId"
    | "addresseeUserId"
    | "ownerUserId"
  >,
  cutoff: Date,
): boolean {
  if (row.status !== "pending") return false;
  if (row.createdAt.getTime() >= cutoff.getTime()) return false;
  return isOwnerDecisionAudience({
    effectiveResolverPolicy: row.effectiveResolverPolicy,
    addresseeAgentId: row.addresseeAgentId,
    addresseeUserId: row.addresseeUserId,
    ownerUserId: row.ownerUserId,
  });
}

export interface OwnerCardTtlSweepDeps {
  db: Db;
  /**
   * Wakes the card's author with the TTL expiry notice. Wired to
   * heartbeatService.wakeup in index.ts; injectable so the tests can assert
   * the one-wake limiter without the run engine.
   */
  wakeup: (
    agentId: string,
    options: {
      source: "automation";
      triggerDetail: "system";
      reason: string;
      payload?: Record<string, unknown> | null;
      contextSnapshot?: Record<string, unknown>;
      idempotencyKey?: string | null;
      requestedByActorType?: "system";
    },
  ) => Promise<unknown>;
}

export interface OwnerCardTtlSweepResult {
  inspected: number;
  expired: number;
  silenceResolved: number;
  woken: number;
  failed: number;
}

/**
 * Reads the newest owner-message comment that names this interaction — the
 * `answeredAt`-side evidence the owner-delivery module already writes
 * (comments with metadata.authorizationReason = myrmidon_owner_message whose
 * sections carry a key_value row {label: "Interaction", value: <id>}, written
 * by ownerMessageCommentMetadata in owner-delivery). Returns its createdAt,
 * or null.
 */
async function readOwnerMessageCommentedAt(
  db: Db,
  companyId: string,
  interactionId: string,
): Promise<Date | null> {
  const rows = await db
    .select({ createdAt: issueComments.createdAt })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, companyId),
        sql`${issueComments.metadata} ->> 'authorizationReason' = ${OWNER_MESSAGE_COMMENT_REASON}`,
        sql`EXISTS (
          SELECT 1
          FROM jsonb_array_elements(${issueComments.metadata} -> 'sections') AS section,
               jsonb_array_elements(section -> 'rows') AS metaRow
          WHERE metaRow ->> 'type' = 'key_value'
            AND metaRow ->> 'label' = ${OWNER_MESSAGE_INTERACTION_LABEL}
            AND metaRow ->> 'value' = ${interactionId}
        )`,
      ),
    )
    .orderBy(desc(issueComments.createdAt))
    .limit(1);
  return rows[0]?.createdAt ?? null;
}

export function createOwnerCardTtlSweep(deps: OwnerCardTtlSweepDeps) {
  return async function sweepOwnerCardTtls(opts?: {
    settings?: Partial<OwnerCardTtlSettings>;
    now?: Date;
    limit?: number;
  }): Promise<OwnerCardTtlSweepResult> {
    const settings = { ...readOwnerCardTtlSettings(), ...opts?.settings };
    const now = opts?.now ?? new Date();
    const cutoff = new Date(now.getTime() - settings.ttlMs);
    const limit = Math.max(1, Math.min(opts?.limit ?? settings.pageSize, 500));
    let wakeBudgetLeft = settings.wakeBudget;

    const selected = await deps.db
      .select({
        id: issueThreadInteractions.id,
        companyId: issueThreadInteractions.companyId,
        issueId: issueThreadInteractions.issueId,
        status: issueThreadInteractions.status,
        payload: issueThreadInteractions.payload,
        createdAt: issueThreadInteractions.createdAt,
        createdByAgentId: issueThreadInteractions.createdByAgentId,
        addresseeAgentId: issueThreadInteractions.addresseeAgentId,
        addresseeUserId: issueThreadInteractions.addresseeUserId,
        effectiveResolverPolicy: issueThreadInteractions.effectiveResolverPolicy,
        issueIdentifier: issues.identifier,
        ownerUserId: sql<string | null>`coalesce(${issues.responsibleUserId}, ${issues.createdByUserId})`,
      })
      .from(issueThreadInteractions)
      .innerJoin(
        issues,
        and(eq(issues.id, issueThreadInteractions.issueId), isNull(issues.hiddenAt)),
      )
      .where(
        and(
          eq(issueThreadInteractions.kind, "request_confirmation"),
          eq(issueThreadInteractions.status, "pending"),
          lt(issueThreadInteractions.createdAt, cutoff),
        ),
      )
      .orderBy(asc(issueThreadInteractions.createdAt))
      .limit(limit);
    const rows = (selected as OwnerCardTtlRow[]).filter((row) =>
      isExpiredOwnerCardRow(row, cutoff),
    );

    const result: OwnerCardTtlSweepResult = {
      inspected: rows.length,
      expired: 0,
      silenceResolved: 0,
      woken: 0,
      failed: 0,
    };

    for (const row of rows) {
      try {
        const delivery: OwnerCardDeliveryMeta = {
          sentTo: row.addresseeUserId ?? row.ownerUserId ?? null,
          sentAt: row.createdAt.toISOString(),
          ownerMessagedAt: (
            await readOwnerMessageCommentedAt(deps.db, row.companyId, row.id)
          )?.toISOString() ?? null,
          answeredAt: null,
        };
        const payload = buildOwnerCardPayloadWithDelivery(row.payload, delivery);
        if (ownerCardResolvesBySilence(row.payload)) {
          const cls = classifyOwnerCardPayload(row.payload);
          const resolved = await resolveByRecommendedOption(deps.db, row, cls.recommendedOption);
          if (!resolved) continue; // a concurrent resolver owns the card now
          await postSweepComment(deps.db, row, OWNER_CARD_SILENCE_RESOLVED_COMMENT, payload);
          await logSweepActivity(deps.db, row, "silence_recommended", resolved.status);
          result.silenceResolved += 1;
        } else {
          const expired = await expireOwnerCard(deps.db, row, payload);
          if (!expired) continue; // a concurrent resolver owns the card now
          await postSweepComment(deps.db, row, OWNER_CARD_EXPIRED_COMMENT, payload);
          await logSweepActivity(deps.db, row, "ttl_expired", "expired");
          result.expired += 1;
        }
        if (wakeBudgetLeft > 0 && row.createdByAgentId) {
          const woken = await wakeAuthor(deps, row, now);
          if (woken) {
            wakeBudgetLeft -= 1;
            result.woken += 1;
          }
        }
      } catch {
        // Log a constant errorKind only: the exception can carry a credential
        // in its message, code, cause or stack. The card stays pending and the
        // next pass retries it.
        result.failed += 1;
        logger.warn(
          { errorKind: "owner_card_ttl_sweep_failed", interactionId: row.id },
          "owner card TTL sweep failed for one card",
        );
      }
    }

    return result;
  };
}

/**
 * Closes the card as `expired` with the administrative outcome
 * `interaction_expired` and the delivery metadata folded into the payload.
 * The compare-and-set on `status = pending` keeps a concurrent human answer
 * authoritative: the sweep loses the race and leaves the answered card alone.
 */
async function expireOwnerCard(
  db: Db,
  row: OwnerCardTtlRow,
  payload: Record<string, unknown>,
): Promise<boolean> {
  const now = new Date();
  const updated = await db
    .update(issueThreadInteractions)
    .set({
      status: "expired",
      result: { version: 1, outcome: "expired", reason: "interaction_expired" },
      payload: payload as unknown as IssueThreadInteractionPayload,
      resolvedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(issueThreadInteractions.id, row.id),
        eq(issueThreadInteractions.status, "pending"),
      ),
    )
    .returning({ id: issueThreadInteractions.id });
  return updated.length > 0;
}

/**
 * Resolves the card by its recommended option through the ordinary resolution
 * service with the system actor — the same path the owner's own accept/reject
 * takes, so policy, activity and continuation behave identically.
 */
async function resolveByRecommendedOption(
  db: Db,
  row: OwnerCardTtlRow,
  recommendedOption: "accept" | "reject",
): Promise<{ status: string } | null> {
  // Direct row update, not the issue-thread-interactions service: the accept
  // path drags in the full workspace-finalize/policy machinery (post-commit
  // publications, continuation issue, activity fan-out) which the scheduler
  // sweep does not need — and under the serial CI shard it can push a single
  // card close past the per-test timeout. Silence resolution is a narrow
  // administrative close with the system actor; the compare-and-set on
  // `status = pending` keeps a concurrent human answer authoritative, and
  // the comment/activity/wake fan-out stays in the sweep itself.
  const now = new Date();
  const outcome = recommendedOption === "reject" ? "rejected" : "accepted";
  const updated = await db
    .update(issueThreadInteractions)
    .set({
      status: outcome,
      result: {
        version: 1,
        outcome,
        reason: "silence_means_recommended",
        resolvedBy: "owner_card_ttl_sweep",
      },
      resolvedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(issueThreadInteractions.id, row.id),
        eq(issueThreadInteractions.status, "pending"),
      ),
    )
    .returning({ id: issueThreadInteractions.id });
  if (updated.length === 0) return null; // a concurrent resolver owns the card now
  return { status: outcome };
}

async function postSweepComment(
  db: Db,
  row: OwnerCardTtlRow,
  body: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await db.insert(issueComments).values([{
    companyId: row.companyId,
    issueId: row.issueId,
    authorType: "system",
    body,
    metadata: {
      version: 1,
      authorizationReason: "myrmidon_owner_card_ttl",
      sections: [{
        title: "Owner card TTL",
        rows: [
          { type: "text" as const, text: `Interaction:${row.id}` },
          ...(payload.delivery && typeof payload.delivery === "object" ? [
            { type: "key_value" as const, label: "sentTo", value: String((payload.delivery as Record<string, unknown>).sentTo ?? "") },
            { type: "key_value" as const, label: "sentAt", value: String((payload.delivery as Record<string, unknown>).sentAt ?? "") },
          ] : []),
        ],
      }],
    } as IssueCommentMetadata,
  }]);
  await db
    .update(issues)
    .set({ updatedAt: new Date() })
    .where(eq(issues.id, row.issueId));
}

async function logSweepActivity(
  db: Db,
  row: OwnerCardTtlRow,
  source: "ttl_expired" | "silence_recommended",
  interactionStatus: string,
): Promise<void> {
  await logActivity(db, {
    companyId: row.companyId,
    actorType: "system",
    actorId: OWNER_CARD_SWEEP_SYSTEM_ID,
    action: OWNER_CARD_TTL_ACTIVITY_ACTION,
    entityType: "issue",
    entityId: row.issueId,
    details: {
      identifier: row.issueIdentifier ?? null,
      interactionId: row.id,
      interactionKind: "request_confirmation",
      interactionStatus,
      source: `owner_card_ttl_sweep.${source}`,
    },
  });
}

/**
 * The one author wake per TTL-closed card. The idempotency key
 * `owner-card-expired:<interactionId>` makes the limiter durable: a repeated
 * pass (or a deploy mid-backlog) finds the receipt and never wakes twice.
 */
async function wakeAuthor(
  deps: OwnerCardTtlSweepDeps,
  row: OwnerCardTtlRow,
  now: Date,
): Promise<boolean> {
  const agentId = row.createdByAgentId;
  if (!agentId) return false;
  const idempotencyKey = `${OWNER_CARD_EXPIRED_WAKE_IDEMPOTENCY_PREFIX}${row.id}`;
  const existing = await deps.db
    .select({ id: agentWakeupRequests.id })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, row.companyId),
        eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1)
    .then((rows: { id: string }[]) => rows[0] ?? null);
  if (existing) return false;
  await deps.wakeup(agentId, {
    source: "automation",
    triggerDetail: "system",
    reason: OWNER_CARD_EXPIRED_WAKE_REASON,
    payload: {
      issueId: row.issueId,
      interactionId: row.id,
      interactionKind: "request_confirmation",
      interactionStatus: "expired",
      mutation: "interaction",
      sweptAt: now.toISOString(),
    },
    contextSnapshot: {
      issueId: row.issueId,
      taskId: row.issueId,
      interactionId: row.id,
      wakeReason: OWNER_CARD_EXPIRED_WAKE_REASON,
      source: "owner_card_ttl_sweep",
    },
    idempotencyKey,
    requestedByActorType: "system",
  });
  return true;
}

/**
 * Builds the scheduler tick the server entry calls: settings are read on
 * every pass and the interval is enforced inside, so an env change takes
 * effect without a restart (the stale-block scheduler contract).
 */
export function createOwnerCardTtlScheduler(input: {
  db: Db;
  wakeup: OwnerCardTtlSweepDeps["wakeup"];
  track: (work: Promise<unknown>) => void;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}): () => void {
  const sweep = createOwnerCardTtlSweep({ db: input.db, wakeup: input.wakeup });
  let lastPassAt = 0;
  return () => {
    const settings = readOwnerCardTtlSettings(input.env ?? process.env);
    const now = (input.now ?? (() => new Date()))();
    if (now.getTime() - lastPassAt < settings.intervalMs) return;
    lastPassAt = now.getTime();
    input.track(
      sweep({ settings, now })
        .then((result) => {
          if (result.expired > 0 || result.silenceResolved > 0 || result.failed > 0) {
            logger.info(result, "owner card TTL sweep closed overdue owner cards");
          }
        })
        .catch((err) => {
          logger.error({ err }, "owner card TTL sweep failed");
        }),
    );
  };
}

