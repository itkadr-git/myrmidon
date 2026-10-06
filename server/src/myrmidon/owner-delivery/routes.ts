// myrmidon(1.6.5-OWNER-DM-FILTER): owner-DM delivery journal.
//
// GET /api/myrmidon/owner-delivery/publications?since=<iso> (instance admin):
// the list of chat publications that landed in owner-DM conversations
// (direct-message conversations of a telegram:* conversation issue) created
// at or after `since`, each labeled with the frozen part-A/C classification:
//
//   "owner_decision" <=> effectiveResolverPolicy == "human_only"
//                       OR addresseeUserId == (issue.responsibleUserId
//                                              ?? issue.createdByUserId)
//   otherwise "operational".
//
// The classification is derived from the card's interaction row (joined via
// payload->>'interactionId'), never stored: the table keeps only what the
// vendor outbox already records.
//
// Reading this journal after the part-A filter ships: an "operational" entry
// can only come from a publication row created BEFORE the filter rollout —
// the filter stops new operational cards from being enqueued into owner DMs
// at all. A fresh "operational" row after the rollout is the alarm the
// parent acceptance criterion watches for.

import { Router } from "express";
import { and, eq, gte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  chatConversations,
  chatPublications,
  issueThreadInteractions,
  issues,
  type Db,
} from "@paperclipai/db";
import { badRequest } from "../../errors.js";
import { assertInstanceAdmin } from "../../routes/authz.js";
import {
  classifyOwnerDeliveryPublication,
  type OwnerDeliveryClassification,
} from "./classify.js";

const MAX_ITEMS = 500;

export interface OwnerDeliveryPublicationItem {
  publicationId: string;
  createdAt: string;
  issueId: string;
  interactionId: string | null;
  classification: OwnerDeliveryClassification;
  reason: string;
}

export function ownerDeliveryRoutes(db: Db): Router {
  const router = Router();

  router.get("/myrmidon/owner-delivery/publications", async (req, res) => {
    assertInstanceAdmin(req);
    const sinceParam = req.query.since;
    if (typeof sinceParam !== "string" || sinceParam.trim() === "") {
      throw badRequest("Query parameter 'since' (ISO timestamp) is required");
    }
    const since = new Date(sinceParam);
    if (Number.isNaN(since.getTime())) {
      throw badRequest("Query parameter 'since' must be a valid ISO timestamp");
    }

    // Two roles for `issues` in this query: the conversation's own issue
    // marks owner-DM conversations, and the publication's issue owns the
    // owner used by the classification. Alias keeps the joins distinct.
    const conversationIssue = alias(issues, "conversation_issue");
    const cardIssue = alias(issues, "card_issue");

    const rows = await db
      .select({
        publicationId: chatPublications.id,
        publicationCreatedAt: chatPublications.createdAt,
        issueId: chatPublications.issueId,
        interactionId: sql<
          string | null
        >`${chatPublications.payload}->>'interactionId'`,
        effectiveResolverPolicy: issueThreadInteractions.effectiveResolverPolicy,
        addresseeUserId: issueThreadInteractions.addresseeUserId,
        issueResponsibleUserId: cardIssue.responsibleUserId,
        issueCreatedByUserId: cardIssue.createdByUserId,
      })
      .from(chatPublications)
      .innerJoin(
        chatConversations,
        and(
          eq(chatConversations.companyId, chatPublications.companyId),
          eq(chatConversations.id, chatPublications.conversationId),
          eq(chatConversations.isDirectMessage, true),
        ),
      )
      // The conversation's own issue marks owner-DM conversations: the X8b
      // standing DM lives as an issue whose conversationUserId is
      // `telegram:<boardUserId>`.
      .innerJoin(
        conversationIssue,
        and(
          eq(conversationIssue.companyId, chatConversations.companyId),
          eq(conversationIssue.id, chatConversations.issueId),
          sql`${conversationIssue.conversationUserId} like 'telegram:%'`,
        ),
      )
      // The card-owning task: owns the owner used by the classification.
      // Interaction join keyed by payload->>'interactionId'; the regex guard
      // keeps legacy rows with a non-uuid (or missing) interactionId from
      // failing the ::uuid cast — such rows simply fall out of the journal,
      // which only covers interaction-driven cards.
      .innerJoin(
        issueThreadInteractions,
        and(
          eq(
            issueThreadInteractions.companyId,
            chatPublications.companyId,
          ),
          sql`${chatPublications.payload}->>'interactionId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'`,
          eq(
            issueThreadInteractions.id,
            sql<string>`(${chatPublications.payload}->>'interactionId')::uuid`,
          ),
        ),
      )
      .leftJoin(
        cardIssue,
        and(
          eq(cardIssue.companyId, chatPublications.companyId),
          eq(cardIssue.id, chatPublications.issueId),
        ),
      )
      .where(gte(chatPublications.createdAt, since))
      .orderBy(chatPublications.createdAt, chatPublications.id)
      .limit(MAX_ITEMS + 1);

    const items: OwnerDeliveryPublicationItem[] = rows
      .slice(0, MAX_ITEMS)
      .map((row) => {
        const { classification, reason } = classifyOwnerDeliveryPublication({
          effectiveResolverPolicy: row.effectiveResolverPolicy,
          addresseeUserId: row.addresseeUserId,
          issueResponsibleUserId: row.issueResponsibleUserId,
          issueCreatedByUserId: row.issueCreatedByUserId,
        });
        return {
          publicationId: row.publicationId,
          createdAt: row.publicationCreatedAt.toISOString(),
          issueId: row.issueId,
          interactionId: row.interactionId ?? null,
          classification,
          reason,
        };
      });

    res.json({ items, total: items.length });
  });

  return router;
}
