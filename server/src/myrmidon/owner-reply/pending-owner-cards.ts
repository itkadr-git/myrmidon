// server/src/myrmidon/owner-reply/pending-owner-cards.ts
//
// myrmidon(1.6.5-F21-A): which pending owner card does a sentence close?
//
// Two entry points, one shape: the owner comments on the task (the issue-scoped
// list below) or answers a DM (the agent-conversation list below).
//  - a web comment on the task (listPendingOwnerCardsForIssue) — the task-level
//    binding the ticket asks for: the freshest pending owner card of THIS task,
//    created before the answer, no message binding required (cards raised before
//    the owner got a DM are closed by the same rule; there is NO migration);
//  - an inbound Telegram DM message of the owner (listPendingOwnerCardsForAgentDialogue)
//    — the cards this agent has already explained in the standing DM
//    conversation, which is the binding the existing prompt block relies on.
//
// Both return the same PendingOwnerCard, so the parser and the planner never
// care which door the sentence came through.

import { and, eq, inArray, lt } from "drizzle-orm";
import { issueThreadInteractions, issues, type Db } from "@paperclipai/db";
import { isOwnerDecisionAudience } from "@paperclipai/shared";
import {
  OWNER_DIALOGUE_KINDS,
  isPlainOwnerDecisionPayload,
  listOwnerExplanations,
  loadOpenOwnerDecisions,
} from "../owner-delivery/owner-dialogue.js";
import { findOwnerDmBindings } from "../owner-delivery/telegram-owner-bindings.js";
import { ownerReplyCardFromPayload } from "./owner-reply-card.js";
import type { OwnerReplyCard, OwnerReplyCardKind } from "./parse-owner-reply.js";

/** One pending card of the owner that a sentence may close. */
export interface PendingOwnerCard {
  interactionId: string;
  companyId: string;
  issueId: string;
  issueIdentifier: string | null;
  issueTitle: string;
  kind: OwnerReplyCardKind;
  ownerUserId: string;
  createdAt: Date;
  payload: unknown;
  /** The parser's view of the payload. */
  card: OwnerReplyCard;
  /** The agent that owns the card: the one to wake with the owner's answer. */
  assigneeAgentId: string | null;
}

/** Newest first: the freshest card is the one a bare answer closes. */
function byNewestFirst(left: PendingOwnerCard, right: PendingOwnerCard): number {
  const delta = right.createdAt.getTime() - left.createdAt.getTime();
  return delta !== 0 ? delta : right.interactionId.localeCompare(left.interactionId);
}

/**
 * The pending owner cards of one task, freshest first.
 *
 * A card qualifies when it is pending, one of the owner-dialogue kinds, its
 * payload is a plain owner decision, it lives on this (ordinary) task, and its
 * audience is the task owner — the shared rule isOwnerDecisionAudience, fed
 * with the task's own responsible/creator user. `before` (the answer time)
 * drops cards raised after the sentence: an answer never closes a card the
 * owner had not seen yet.
 */
export async function listPendingOwnerCardsForIssue(
  db: Pick<Db, "select">,
  input: { companyId: string; issueId: string; ownerUserId: string; before?: Date | null },
): Promise<PendingOwnerCard[]> {
  const rows = await db
    .select({
      id: issueThreadInteractions.id,
      issueId: issueThreadInteractions.issueId,
      kind: issueThreadInteractions.kind,
      payload: issueThreadInteractions.payload,
      createdAt: issueThreadInteractions.createdAt,
      effectiveResolverPolicy: issueThreadInteractions.effectiveResolverPolicy,
      addresseeAgentId: issueThreadInteractions.addresseeAgentId,
      addresseeUserId: issueThreadInteractions.addresseeUserId,
      identifier: issues.identifier,
      issueTitle: issues.title,
      assigneeAgentId: issues.assigneeAgentId,
      conversationAgentId: issues.conversationAgentId,
    })
    .from(issueThreadInteractions)
    .innerJoin(
      issues,
      and(
        eq(issues.companyId, issueThreadInteractions.companyId),
        eq(issues.id, issueThreadInteractions.issueId),
      ),
    )
    .where(
      and(
        eq(issueThreadInteractions.companyId, input.companyId),
        eq(issueThreadInteractions.issueId, input.issueId),
        eq(issueThreadInteractions.status, "pending"),
        inArray(issueThreadInteractions.kind, [...OWNER_DIALOGUE_KINDS]),
        input.before ? lt(issueThreadInteractions.createdAt, input.before) : undefined,
      ),
    )
    .limit(50);

  const cards: PendingOwnerCard[] = [];
  for (const row of rows) {
    // A conversation task routes its own cards; an agent-addressed card is not
    // an owner decision.
    if (row.conversationAgentId) continue;
    if (row.addresseeAgentId !== null) continue;
    if (
      !isOwnerDecisionAudience({
        effectiveResolverPolicy: row.effectiveResolverPolicy,
        addresseeAgentId: row.addresseeAgentId,
        addresseeUserId: row.addresseeUserId,
        ownerUserId: input.ownerUserId,
      })
    ) {
      continue;
    }
    if (!isPlainOwnerDecisionPayload(row.kind, row.payload)) continue;
    const card = ownerReplyCardFromPayload({
      interactionId: row.id,
      kind: row.kind,
      payload: row.payload,
    });
    if (!card) continue;
    cards.push({
      interactionId: row.id,
      companyId: input.companyId,
      issueId: row.issueId,
      issueIdentifier: row.identifier,
      issueTitle: row.issueTitle,
      kind: card.kind,
      ownerUserId: input.ownerUserId,
      createdAt: row.createdAt,
      payload: row.payload,
      card,
      assigneeAgentId: row.assigneeAgentId,
    });
  }
  return cards.sort(byNewestFirst);
}

/**
 * The pending cards the owner answered through the agent's Telegram DM: the
 * decisions this agent explained in that standing conversation. The explanation
 * (an agent comment whose metadata names the interaction ids) is the binding —
 * exactly what buildOwnerViaBotPromptBlock uses today, so the automatic path
 * and the prompt-hint path can never disagree about which card is meant.
 */
export async function listPendingOwnerCardsForAgentDialogue(
  db: Db,
  input: { companyId: string; agentId: string; ownerUserId: string; before?: Date | null },
): Promise<PendingOwnerCard[]> {
  const [binding] = await findOwnerDmBindings(db, {
    companyId: input.companyId,
    ownerUserId: input.ownerUserId,
    agentId: input.agentId,
  });
  if (!binding) return [];
  const explained = new Set(
    (
      await listOwnerExplanations(db, {
        companyId: input.companyId,
        conversationIssueId: binding.conversation.issueId,
        agentId: input.agentId,
      })
    ).flatMap((entry) => entry.interactionIds),
  );
  if (explained.size === 0) return [];
  const decisions = (
    await loadOpenOwnerDecisions(db, { companyId: input.companyId, agentId: input.agentId })
  ).filter(
    (decision) =>
      decision.ownerUserId === input.ownerUserId && explained.has(decision.interactionId),
  );
  const cards: PendingOwnerCard[] = [];
  for (const decision of decisions) {
    if (input.before && decision.createdAt.getTime() >= input.before.getTime()) continue;
    const card = ownerReplyCardFromPayload({
      interactionId: decision.interactionId,
      kind: decision.kind,
      payload: decision.payload,
    });
    if (!card) continue;
    cards.push({
      interactionId: decision.interactionId,
      companyId: input.companyId,
      issueId: decision.issueId,
      issueIdentifier: decision.issueIdentifier,
      issueTitle: decision.issueTitle,
      kind: card.kind,
      ownerUserId: decision.ownerUserId,
      createdAt: decision.createdAt,
      payload: decision.payload,
      card,
      assigneeAgentId: null,
    });
  }
  return cards.sort(byNewestFirst);
}