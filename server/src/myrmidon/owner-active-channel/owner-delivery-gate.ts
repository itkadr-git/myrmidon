// server/src/myrmidon/owner-active-channel/owner-delivery-gate.ts
//
// myrmidon(1.7-ACTIVE-CHANNEL): the owner-delivery entry point. The U2
// feature (questions and confirmations from ordinary tasks reaching the
// owner's standing Telegram DM) moved here unchanged; the active-channel gate
// of 1.7-ACTIVE-CHANNEL wraps it:
//
//   - the owner is active in Telegram (their `telegram` touch is the freshest
//     one and younger than the inactivity threshold) — the U2 Telegram
//     binding is used;
//   - the owner is active in the portal instead — the card stays board-only,
//     which is exactly where an owner active on the board reads it;
//   - no channel is active — the standing U2 rule: Telegram wins so a card
//     still reaches a passive owner off-portal.
//
// The vendor's own task-thread bindings always win (see the call site in
// services/chat-interaction-publications.ts); nothing here touches them.
import { and, eq, inArray } from "drizzle-orm";
import { chatConversations, chatEndpoints, issues } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { telegramConversationUserId } from "../agent-chat-bridge/identity.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { resolveOwnerActiveChannel } from "./store.js";
import { readOwnerActiveChannelSettings } from "./settings.js";

/** Bindings the owner-delivery extension may hand back to the publication path. */
export interface OwnerDeliveryBinding {
  conversation: typeof chatConversations.$inferSelect;
  endpoint: typeof chatEndpoints.$inferSelect;
}

type OwnerDeliveryDb = Pick<Db, "select">;

/** The owner receiving the card, or null when there is none / the task is its own chat. */
async function ownerUserIdForCard(
  db: OwnerDeliveryDb,
  input: { companyId: string; issueId: string },
): Promise<string | null> {
  const issueRow = await db
    .select({
      responsibleUserId: issues.responsibleUserId,
      createdByUserId: issues.createdByUserId,
      conversationAgentId: issues.conversationAgentId,
      conversationUserId: issues.conversationUserId,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, input.companyId),
        eq(issues.id, input.issueId),
      ),
    )
    .then((rows) => (rows.length > 0 ? rows : []));
  const issue = issueRow[0] ?? null;
  if (!issue) return null;
  // A task that already lives as an Agent Chat conversation (web or Telegram)
  // has its own routing; never mirror its cards into another conversation.
  if (issue.conversationAgentId && issue.conversationUserId) return null;
  // The owner receiving the card: the responsible user when the task names
  // one, otherwise its creator. A board user id, not an external identity.
  return issue.responsibleUserId ?? issue.createdByUserId ?? null;
}

/**
 * myrmidon(1.7-ACTIVE-CHANNEL): the Telegram binding path from U2, gated by
 * the owner's active channel. Returns [] when the owner is active on the
 * board right now — the card stays board-only — and applies the standing U2
 * rules in every other case. A settings or activity read failure never loses
 * the card: it falls back to the pre-gate U2 behavior.
 */
export async function telegramOwnerDeliveryBindings(
  db: OwnerDeliveryDb,
  input: {
    companyId: string;
    issueId: string;
    createdByAgentId: string | null | undefined;
  },
): Promise<OwnerDeliveryBinding[]> {
  if (!input.createdByAgentId) return [];
  const ownerUserId = await ownerUserIdForCard(db, input);
  if (ownerUserId) {
    let activeChannel: "web" | "telegram" | null = null;
    try {
      const resolved = await readOwnerActiveChannelSettings({
        getGeneral: () => instanceSettingsService(db as unknown as Db).getGeneral(),
      });
      activeChannel = await resolveOwnerActiveChannel(db as unknown as Db, ownerUserId, {
        thresholdMin: resolved.thresholdMin,
      });
    } catch {
      activeChannel = null;
    }
    // An owner active in the portal reads cards on the board; do not pull a
    // report into Telegram while they are here.
    if (activeChannel === "web") return [];
  }
  return telegramOwnerDeliveryBindingsU2(db, input);
}

/**
 * myrmidon(U2): find the standing Telegram DM conversation (X8b) between the
 * card's authoring agent and the task's owner, for Telegram endpoints whose
 * bot is that same agent. The rules mirror the vendor's own binding rules so a
 * card never speaks through another agent's endpoint:
 *
 * - the endpoint is Telegram, automatic publication mode, active/verifying;
 * - the endpoint's immutable assigned agent is the card's creator;
 * - the conversation is a live (active/waiting) DM standing conversation of
 *   the task's owner with that agent (`telegram:<boardUserId>` identity).
 *
 * Returns [] when nothing matches, so the caller degrades to vendor behavior.
 */
export async function telegramOwnerDeliveryBindingsU2(
  db: OwnerDeliveryDb,
  input: {
    companyId: string;
    issueId: string;
    createdByAgentId: string | null | undefined;
  },
): Promise<OwnerDeliveryBinding[]> {
  if (!input.createdByAgentId) return [];
  const createdByAgentId = input.createdByAgentId;
  const issueRow = await db
    .select({
      responsibleUserId: issues.responsibleUserId,
      createdByUserId: issues.createdByUserId,
      conversationAgentId: issues.conversationAgentId,
      conversationUserId: issues.conversationUserId,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, input.companyId),
        eq(issues.id, input.issueId),
      ),
    )
    .then((rows) => (rows.length > 0 ? rows : []));
  const issue = issueRow[0] ?? null;
  if (!issue) return [];
  // A task that already lives as an Agent Chat conversation (web or Telegram)
  // has its own routing; never mirror its cards into another conversation.
  if (issue.conversationAgentId && issue.conversationUserId) return [];

  const ownerUserId = issue.responsibleUserId ?? issue.createdByUserId ?? null;
  if (!ownerUserId) return [];

  const rows = await db
    .select({
      conversation: chatConversations,
      endpoint: chatEndpoints,
      conversationIssue: issues,
    })
    .from(chatConversations)
    .innerJoin(
      chatEndpoints,
      and(
        eq(chatEndpoints.companyId, chatConversations.companyId),
        eq(chatEndpoints.id, chatConversations.endpointId),
      ),
    )
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
        eq(
          issues.conversationUserId,
          telegramConversationUserId(ownerUserId),
        ),
        eq(issues.conversationAgentId, createdByAgentId),
        inArray(chatConversations.state, ["active", "waiting"]),
        inArray(chatEndpoints.status, ["active", "verifying"]),
      ),
    );
  return rows.filter(
    ({ conversation, endpoint }) =>
      endpoint.provider === "telegram" &&
      endpoint.publicationMode === "automatic" &&
      endpoint.assignedAgentId === createdByAgentId &&
      conversation.isDirectMessage === true,
  );
}
