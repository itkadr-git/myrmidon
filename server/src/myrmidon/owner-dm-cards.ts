// myrmidon(1.4-U2): owner-facing Telegram delivery for pending question and
// confirmation cards. Cards for tasks that have no chat thread of their own
// never leave the board today, so an owner who lives in the Telegram DM (the
// X8b standing conversation) cannot see them. This module finds that standing
// DM conversation for a linked board user and reuses the vendor's publication
// path for it. Nothing here talks to a provider: it only stages rows.
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  chatConversations,
  chatEndpoints,
  issues,
} from "@paperclipai/db";
import type { IssueThreadInteraction } from "@paperclipai/shared";
import { parseTelegramConversationUserId } from "../myrmidon/agent-chat-bridge/identity.js";
import { telegramDmConversationsEnabled } from "../myrmidon/agent-chat-bridge/settings.js";

type OwnerDmDb = Pick<Db, "select">;

/**
 * Whether an endpoint may receive owner-facing interaction cards in its
 * bridged Telegram DM. Rides the X8b bridge list
 * (`MYRMIDON_TELEGRAM_DM_CONVERSATIONS`, `*` for all) so the card path turns
 * on for exactly the pilot endpoints as the standing conversation itself:
 * no bridge, no owner cards in the DM. Unset or blank — off for every
 * endpoint, and the vendor path is unchanged.
 */
export function telegramOwnerDmCardsEnabled(
  endpointId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return telegramDmConversationsEnabled(endpointId, env);
}

/**
 * The chat_conversations row of the standing Telegram DM conversation that
 * belongs to a board user on a bridge-enabled endpoint, or null when there is
 * none (the DM has never been bridged, the link is gone, or the flag is off).
 * Read-only; the caller stages its own publication.
 *
 * Selection is deliberately narrow: same company, telegram provider, DM,
 * active/waiting state, and an issue whose conversation_user_id decodes to
 * this board user (the X8b key `telegram:<board user id>`).
 */
export async function findOwnerTelegramDmConversation(
  db: OwnerDmDb,
  input: {
    companyId: string;
    endpointId: string;
    boardUserId: string;
  },
): Promise<{
  conversationId: string;
  issueId: string;
} | null> {
  const conversations = await db
    .select({
      id: chatConversations.id,
      issueId: chatConversations.issueId,
      state: chatConversations.state,
      sessionGeneration: chatConversations.sessionGeneration,
      conversationUserId: issues.conversationUserId,
    })
    .from(chatConversations)
    .innerJoin(
      issues,
      and(
        eq(issues.companyId, chatConversations.companyId),
        eq(issues.id, chatConversations.issueId),
      ),
    )
    .where(
      and(
        eq(chatConversations.companyId, input.companyId),
        eq(chatConversations.endpointId, input.endpointId),
        eq(chatConversations.isDirectMessage, true),
        inArray(chatConversations.state, ["active", "waiting"]),
      ),
    )
    .orderBy(desc(chatConversations.sessionGeneration));
  for (const conversation of conversations) {
    if (
      parseTelegramConversationUserId(conversation.conversationUserId) !==
      input.boardUserId
    ) {
      continue;
    }
    return {
      conversationId: conversation.id,
      issueId: conversation.issueId,
    };
  }
  return null;
}

/**
 * Bridge-enabled Telegram endpoints of a company whose assigned agent could
 * speak in that DM (an endpoint is one immutable bot identity). Used by the
 * card publisher to decide where an owner-facing card may go.
 */
export async function telegramOwnerDmEndpoints(
  db: OwnerDmDb,
  input: { companyId: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<
  Array<{ endpointId: string; assignedAgentId: string | null }>
> {
  const endpoints = await db
    .select({
      id: chatEndpoints.id,
      provider: chatEndpoints.provider,
      status: chatEndpoints.status,
      publicationMode: chatEndpoints.publicationMode,
      assignedAgentId: chatEndpoints.assignedAgentId,
    })
    .from(chatEndpoints)
    .where(
      and(
        eq(chatEndpoints.companyId, input.companyId),
        inArray(chatEndpoints.status, ["active", "verifying"]),
      ),
    );
  return endpoints
    .filter(
      (endpoint) =>
        endpoint.provider === "telegram" &&
        endpoint.publicationMode === "automatic" &&
        telegramOwnerDmCardsEnabled(endpoint.id, env),
    )
    .map((endpoint) => ({
      endpointId: endpoint.id,
      assignedAgentId: endpoint.assignedAgentId,
    }));
}

/**
 * Whether an interaction is eligible for owner-DM delivery at all: pending
 * question/confirmation cards only (the same native-chat wave the vendor
 * externalizes), created by an agent (user/system cards stay authoritative
 * on the board).
 */
export function ownerDmEligibleInteraction(
  interaction: IssueThreadInteraction,
): boolean {
  return (
    interaction.status === "pending" &&
    (interaction.kind === "ask_user_questions" ||
      interaction.kind === "request_confirmation") &&
    interaction.createdByAgentId !== null
  );
}

