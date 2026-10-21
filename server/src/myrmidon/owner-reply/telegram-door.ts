// server/src/myrmidon/owner-reply/telegram-door.ts
//
// myrmidon(1.6.6-U2-REPLY): the inbound Telegram door of the owner's words.
//
// The owner answers the bot's plain-text message in the standing direct chat.
// handleOwnerTextReply already knows how to turn a sentence into a resolution
// of the cards the agent explained in that chat (the "agent dialogue" list);
// what was missing is the call from the inbound chat ingest and the binding of
// a Telegram reply to the exact message it answers:
//
//  - a message that replies to a bot message narrows the candidates to the
//    cards THAT message explained, so a second open question is never guessed;
//  - a reply to a message that explains nothing (an old chat line, a message of
//    another conversation) closes nothing and never falls back to another card;
//  - a message that replies to nothing keeps the ordinary rule: exactly one
//    open explained card closes, several make the bot ask which one.

import { and, eq } from "drizzle-orm";
import { chatMessageLinks, type Db } from "@paperclipai/db";
import { listOwnerExplanations } from "../owner-delivery/owner-dialogue.js";
import type { PendingOwnerCard } from "./pending-owner-cards.js";
import {
  handleOwnerTextReply,
  type OwnerReplyDeps,
  type OwnerReplyOutcome,
} from "./owner-task-reply.js";

/**
 * The cards a reply may close. `repliedInteractionIds` is `null` when the
 * message replies to nothing (all candidates stay), and the list of interactions
 * the replied-to message explained otherwise (possibly empty: nothing closes).
 */
export function narrowCardsToReply(
  cards: readonly PendingOwnerCard[],
  repliedInteractionIds: readonly string[] | null,
): PendingOwnerCard[] {
  if (repliedInteractionIds === null) return [...cards];
  const allowed = new Set(repliedInteractionIds);
  return cards.filter((card) => allowed.has(card.interactionId));
}

/**
 * The interactions explained by the bot message a Telegram reply points at.
 * Empty when that message is not an outbound message of this endpoint and
 * conversation, or explains no interaction.
 */
export async function loadRepliedInteractionIds(
  db: Db,
  input: {
    companyId: string;
    endpointId: string;
    conversationId: string;
    conversationIssueId: string;
    agentId: string;
    replyToProviderMessageId: string;
  },
): Promise<string[]> {
  const link = await db
    .select({ commentId: chatMessageLinks.commentId })
    .from(chatMessageLinks)
    .where(
      and(
        eq(chatMessageLinks.companyId, input.companyId),
        eq(chatMessageLinks.endpointId, input.endpointId),
        eq(chatMessageLinks.conversationId, input.conversationId),
        eq(chatMessageLinks.providerMessageId, input.replyToProviderMessageId),
        eq(chatMessageLinks.direction, "outbound"),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!link?.commentId) return [];
  const explanations = await listOwnerExplanations(db, {
    companyId: input.companyId,
    conversationIssueId: input.conversationIssueId,
    agentId: input.agentId,
  });
  return explanations.find((entry) => entry.commentId === link.commentId)?.interactionIds ?? [];
}

/**
 * Closes (or keeps pending, or asks about) the owner's card for one inbound
 * Telegram message. Never throws: a defect keeps the card pending and the
 * message flows on to the agent as an ordinary chat message.
 */
export async function handleTelegramOwnerReply(
  deps: OwnerReplyDeps,
  input: {
    companyId: string;
    ownerUserId: string;
    agentId: string;
    text: string;
    replyCommentId: string;
    sourceRef: string;
    at: Date;
    /** `null`: the message replies to nothing. */
    loadReplied: (() => Promise<string[]>) | null;
  },
): Promise<OwnerReplyOutcome> {
  const narrowed: OwnerReplyDeps = {
    ...deps,
    listCards: async (listInput) => {
      const cards = await deps.listCards(listInput);
      if (!input.loadReplied || cards.length === 0) return cards;
      return narrowCardsToReply(cards, await input.loadReplied());
    },
  };
  return handleOwnerTextReply(narrowed, {
    companyId: input.companyId,
    ownerUserId: input.ownerUserId,
    text: input.text,
    agentId: input.agentId,
    replyCommentId: input.replyCommentId,
    sourceRef: input.sourceRef,
    at: input.at,
  });
}
