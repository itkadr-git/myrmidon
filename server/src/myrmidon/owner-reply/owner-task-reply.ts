// server/src/myrmidon/owner-reply/owner-task-reply.ts
//
// myrmidon(1.6.5-F21-A): the door an owner sentence comes through.
//
// Two call sites use this one function:
//  - the web comment route (server/src/routes/issues.ts): the owner comments on
//    the task and the freshest pending owner card of that task closes;
//  - the inbound Telegram path (the owner's DM message is recorded by the chat
//    channel service): the cards that agent already explained in that standing
//    conversation close.
//
// The function owns no state machine: it selects the card, decides the plan and
// hands the plan to the injected deps, whose default implementation calls the
// same services the ordinary accept/reject/respond routes call (see
// owner-reply-execution.ts). Everything it does is gated on the via_bot owner
// delivery mode: in the other modes the owner answers on the board card itself,
// and a sentence in a comment must not silently resolve anything.

import type { OwnerDeliveryMode } from "@paperclipai/shared";
import type { PendingOwnerCard } from "./pending-owner-cards.js";
import { planOwnerReply, type OwnerReplyPendingReason } from "./owner-reply-plan.js";

/** What the executor needs to write; injected so the plan stays unit-testable. */
export interface OwnerReplyDeps {
  readMode: () => Promise<OwnerDeliveryMode>;
  listCards: (input: {
    companyId: string;
    ownerUserId: string;
    issueId: string | null;
    agentId: string | null;
    /** The answer time: cards raised after it never close. */
    before: Date;
  }) => Promise<PendingOwnerCard[]>;
  /** Cards already re-asked for this very answer (idempotency: one re-ask per answer). */
  loadReaskMarks: (input: {
    companyId: string;
    issueId: string | null;
    answerKey: string;
    cardIds: readonly string[];
  }) => Promise<readonly string[]>;
  resolveCard: (input: OwnerReplyResolveInput) => Promise<{ status: string }>;
  reaskCard: (input: {
    card: PendingOwnerCard;
    ownerUserId: string;
    reason: OwnerReplyPendingReason;
    text: string;
    answerKey: string;
    runId: string | null;
  }) => Promise<void>;
  askWhichCard: (input: {
    cards: readonly PendingOwnerCard[];
    ownerUserId: string;
    text: string;
    answerKey: string;
  }) => Promise<void>;
}

/** One resolution, in the shape the ordinary resolution route would send it. */
export interface OwnerReplyResolveInput {
  card: PendingOwnerCard;
  action: "accept" | "reject" | "respond";
  body: Record<string, unknown>;
  ownerUserId: string;
  /** The owner's comment that answered the card, when the door was a web comment. */
  replyCommentId: string | null;
  sourceRef: string;
  runId: string | null;
}

export interface OwnerReplyInput {
  companyId: string;
  ownerUserId: string;
  /** The owner's own words. */
  text: string;
  /** The task whose card is in play (web comment door). */
  issueId?: string | null;
  /** The agent whose DM the message arrived in (Telegram door). */
  agentId?: string | null;
  /** The owner comment that carried the words, when there is one. */
  replyCommentId?: string | null;
  /**
   * Stable name of this answer: the reply comment id when there is one, else
   * something the caller owns (message id, event id). It keys the re-ask mark.
   */
  sourceRef: string;
  runId?: string | null;
  /** Answer time; defaults to now. */
  at?: Date;
}

export type OwnerReplyOutcome =
  | { outcome: "skipped_mode"; mode: OwnerDeliveryMode }
  | { outcome: "no_card" }
  | {
      outcome: "resolved";
      interactionId: string;
      action: "accept" | "reject" | "respond";
      status: string;
    }
  | {
      outcome: "kept_pending";
      interactionId: string;
      reason: OwnerReplyPendingReason;
      reasked: boolean;
    }
  | { outcome: "asked_which_card"; interactionIds: string[] }
  | { outcome: "failed"; error: string };

/**
 * Close (or keep pending) the owner's card for a sentence the owner wrote.
 *
 * Nothing here throws: the caller is a comment route or an inbound message
 * writer, and a defect in the owner-reply path must never fail the owner's own
 * write. A failure is reported as `failed` with the message, and the card stays
 * pending — the safe direction.
 */
export async function handleOwnerTextReply(
  deps: OwnerReplyDeps,
  input: OwnerReplyInput,
): Promise<OwnerReplyOutcome> {
  const text = input.text.trim();
  if (text.length === 0) return { outcome: "no_card" };
  try {
    const mode = await deps.readMode();
    if (mode !== "via_bot") return { outcome: "skipped_mode", mode };

    const at = input.at ?? new Date();
    const issueId = input.issueId ?? null;
    const agentId = input.agentId ?? null;
    if (!issueId && !agentId) return { outcome: "no_card" };

    const cards = await deps.listCards({
      companyId: input.companyId,
      ownerUserId: input.ownerUserId,
      issueId,
      agentId,
      before: at,
    });
    if (cards.length === 0) return { outcome: "no_card" };

    const answerKey = input.replyCommentId ?? input.sourceRef;
    const alreadyReaskedFor =
      cards.length === 1
        ? await deps.loadReaskMarks({
            companyId: input.companyId,
            issueId,
            answerKey,
            cardIds: cards.map((card) => card.interactionId),
          })
        : [];
    const plan = planOwnerReply({ text, cards, alreadyReaskedFor });

    switch (plan.kind) {
      case "none":
        return { outcome: "no_card" };
      case "ask_which_card": {
        await deps.askWhichCard({
          cards: plan.cards,
          ownerUserId: input.ownerUserId,
          text,
          answerKey,
        });
        return {
          outcome: "asked_which_card",
          interactionIds: plan.cards.map((card) => card.interactionId),
        };
      }
      case "resolve": {
        const result = await deps.resolveCard({
          card: plan.card,
          action: plan.action,
          body: plan.body,
          ownerUserId: input.ownerUserId,
          replyCommentId: input.replyCommentId ?? null,
          sourceRef: input.sourceRef,
          runId: input.runId ?? null,
        });
        return {
          outcome: "resolved",
          interactionId: plan.card.interactionId,
          action: plan.action,
          status: result.status,
        };
      }
      case "keep_pending": {
        if (plan.reask) {
          await deps.reaskCard({
            card: plan.card,
            ownerUserId: input.ownerUserId,
            reason: plan.reason,
            text: plan.text,
            answerKey,
            runId: input.runId ?? null,
          });
        }
        return {
          outcome: "kept_pending",
          interactionId: plan.card.interactionId,
          reason: plan.reason,
          reasked: plan.reask,
        };
      }
      default: {
        const exhaustive: never = plan;
        return exhaustive;
      }
    }
  } catch (error) {
    return { outcome: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}