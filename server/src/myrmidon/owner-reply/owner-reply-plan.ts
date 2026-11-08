// server/src/myrmidon/owner-reply/owner-reply-plan.ts
//
// myrmidon(1.6.5-F21-A): what to do with the owner's sentence, decided before
// anything is written. Pure: the plan is a value, the executor applies it. That
// split is what makes "one re-ask per answer", "several cards -> ask which one"
// and "unclear -> never close" testable without a database.
//
// The rule from the ticket, in one place:
//  - no pending card of the owner  -> nothing happens (a chat sentence is not a
//    decision by itself);
//  - several pending cards         -> ask which one, in one line with buttons;
//  - one card, a decision/option   -> close it through the ordinary resolution
//    services;
//  - one card, free text/unclear   -> the card STAYS pending, the words are
//    recorded, and the question is re-asked once.

import type { PendingOwnerCard } from "./pending-owner-cards.js";
import { parseOwnerReply, type OwnerReplyUnclearReason } from "./parse-owner-reply.js";

/** Why a card stayed pending after the owner wrote something. */
export type OwnerReplyPendingReason = "answered_without_decision" | OwnerReplyUnclearReason;

export type OwnerReplyPlan =
  | { kind: "none" }
  | { kind: "ask_which_card"; cards: PendingOwnerCard[] }
  | {
      kind: "resolve";
      card: PendingOwnerCard;
      action: "accept" | "reject" | "respond";
      /** Exactly the body the ordinary accept/reject/respond route would take. */
      body: Record<string, unknown>;
    }
  | {
      kind: "keep_pending";
      card: PendingOwnerCard;
      reason: OwnerReplyPendingReason;
      text: string;
      /** Send the question again, once per owner answer. */
      reask: boolean;
    };

export interface OwnerReplyPlanInput {
  text: string;
  /** The owner's pending cards, freshest first (pending-owner-cards returns them sorted). */
  cards: readonly PendingOwnerCard[];
  /** Cards already re-asked for this very answer: they are not re-asked twice. */
  alreadyReaskedFor?: readonly string[];
}

function reaskAllowed(
  card: PendingOwnerCard,
  alreadyReaskedFor: readonly string[],
): boolean {
  return !alreadyReaskedFor.includes(card.interactionId);
}

/**
 * Decide what the owner's sentence does. Never closes a card on a guess: an
 * unclear sentence keeps the card pending and asks again.
 */
export function planOwnerReply(input: OwnerReplyPlanInput): OwnerReplyPlan {
  const cards = [...input.cards];
  if (cards.length === 0) return { kind: "none" };
  if (cards.length > 1) return { kind: "ask_which_card", cards };

  const [card] = cards;
  if (!card) return { kind: "none" };
  const parsed = parseOwnerReply({ text: input.text, card: card.card });
  const alreadyReaskedFor = input.alreadyReaskedFor ?? [];

  switch (parsed.kind) {
    case "decision":
      return { kind: "resolve", card, action: parsed.decision, body: {} };
    case "selection":
      return { kind: "resolve", card, action: "respond", body: { answers: parsed.selections } };
    case "comment":
      return {
        kind: "keep_pending",
        card,
        reason: "answered_without_decision",
        text: parsed.text,
        reask: reaskAllowed(card, alreadyReaskedFor),
      };
    case "unclear":
      return {
        kind: "keep_pending",
        card,
        reason: parsed.reason,
        text: input.text.trim(),
        reask: reaskAllowed(card, alreadyReaskedFor),
      };
    default: {
      const exhaustive: never = parsed;
      return exhaustive;
    }
  }
}