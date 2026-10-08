// myrmidon(U2): deliver an agent's question/confirmation card to the owner's
// standing Telegram DM conversation (the X8b bridge) when the task the card
// belongs to has no chat-thread binding of its own. Everything the vendor
// already enqueues stays untouched; this only adds bindings the vendor cannot
// know about. See docs/myrmidon/DIVERGENCE.md, track 4 (U2).
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  chatConversations,
  chatEndpoints,
  companyMemberships,
  instanceSettings,
  issues,
} from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import {
  OWNER_DELIVERY_DEFAULT_MODE,
  OWNER_DELIVERY_SETTINGS_KEY,
  normalizeOwnerDeliverySettings,
  ownerDeliveryAllowsCard,
  type OwnerDeliveryMode,
} from "@paperclipai/shared";
import { telegramConversationUserId } from "../agent-chat-bridge/identity.js";

/** Bindings the owner-delivery extension may hand back to the publication path. */
export interface OwnerDeliveryBinding {
  conversation: typeof chatConversations.$inferSelect;
  endpoint: typeof chatEndpoints.$inferSelect;
}

/**
 * myrmidon(1.6.5-OWNER-DM-FILTER): the stored filter mode of the singleton
 * instance settings row (instance_settings is a singleton table — no company
 * scoping on the row itself; the mode applies to every company).
 */
export async function readOwnerDeliveryMode(db: OwnerDeliveryDb): Promise<OwnerDeliveryMode> {
  const row = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!row) return OWNER_DELIVERY_DEFAULT_MODE;
  const general = (row.general ?? {}) as Record<string, unknown>;
  return normalizeOwnerDeliverySettings(general[OWNER_DELIVERY_SETTINGS_KEY]).mode;
}

export type OwnerDeliveryDb = Pick<Db, "select">;

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
export async function telegramOwnerDeliveryBindings(
  db: OwnerDeliveryDb,
  input: {
    companyId: string;
    issueId: string;
    createdByAgentId: string | null | undefined;
    // myrmidon(1.6.5-OWNER-DM-FILTER): the interaction's vendor-computed
    // audience fields; the filter consumes them as-is (no recomputation).
    effectiveResolverPolicy?: string | null;
    addresseeAgentId?: string | null;
    addresseeUserId?: string | null;
  },
): Promise<OwnerDeliveryBinding[]> {
  if (!input.createdByAgentId) return [];
  const createdByAgentId = input.createdByAgentId;
  const [issueRow] = await db
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
  const issue = issueRow ?? null;
  if (!issue) return [];
  // A task that already lives as an Agent Chat conversation (web or Telegram)
  // has its own routing; never mirror its cards into another conversation.
  if (issue.conversationAgentId && issue.conversationUserId) return [];

  // myrmidon(1.6.5-OWNER-FALLBACK): the owner receiving the card is chosen by
  // the shared rule (addressee, responsible, creator, company owners) among
  // the users who have a live DM with the card's author. Under "via_bot" no
  // card reaches the DM at all, so there is nothing to resolve.
  const mode = await readOwnerDeliveryMode(db);
  if (mode === "via_bot") return [];
  // myrmidon(1.6.5-OWNER-DM-FILTER): the audience gate. An agent-addressed
  // card is operational traffic between agents — never an owner decision,
  // regardless of the resolver policy. Under the default mode the owner's DM
  // receives only human-addressed cards; "all" restores the old behaviour.
  const addressedToAgent =
    input.addresseeAgentId !== null && input.addresseeAgentId !== undefined;
  if (addressedToAgent && mode !== "all") return [];
  const chosen = await resolveOwnerDecisionRecipient(db, {
    companyId: input.companyId,
    agentId: createdByAgentId,
    addresseeUserId: addressedToAgent ? null : input.addresseeUserId,
    responsibleUserId: issue.responsibleUserId,
    createdByUserId: issue.createdByUserId,
  });
  if (!chosen) return [];
  const ownerUserId = chosen.ownerUserId;
  if (
    !ownerDeliveryAllowsCard({
      mode,
      effectiveResolverPolicy:
        addressedToAgent
          ? "agent_addressee"
          : (input.effectiveResolverPolicy ?? ""),
      addresseeUserId: addressedToAgent ? null : input.addresseeUserId,
      ownerUserId,
    })
  ) {
    return [];
  }

  return chosen.bindings;
}

/**
 * myrmidon(1.6.5-OWNER-FALLBACK): the one rule that names the human who gets an
 * owner decision, shared by loadOpenOwnerDecisions (what waits for the owner),
 * the delivery-binding lookup above and, through the former, the reply
 * authorization. Candidates in order: the interaction's human addressee, the
 * task's responsible user, the task's creator, then the active owner(s) of the
 * company. The first candidate who has a live Telegram DM with `agentId` wins;
 * a candidate without one (an operator service account, a user who never
 * opened the bot) is skipped. Returns null when nobody qualifies — the
 * decision then stays on the board.
 */
export async function resolveOwnerDecisionRecipient(
  db: OwnerDeliveryDb,
  input: {
    companyId: string;
    agentId: string;
    addresseeUserId?: string | null;
    responsibleUserId?: string | null;
    createdByUserId?: string | null;
  },
  cache?: Map<string, Promise<string[]>>,
): Promise<{ ownerUserId: string; bindings: OwnerDeliveryBinding[] } | null> {
  const tried = new Set<string>();
  const attempt = async (userId: string | null | undefined) => {
    if (!userId || tried.has(userId)) return null;
    tried.add(userId);
    const bindings = await findOwnerDmBindings(db, {
      companyId: input.companyId,
      ownerUserId: userId,
      agentId: input.agentId,
    });
    return bindings.length > 0 ? { ownerUserId: userId, bindings } : null;
  };
  for (const userId of [input.addresseeUserId, input.responsibleUserId, input.createdByUserId]) {
    const found = await attempt(userId);
    if (found) return found;
  }
  let owners = cache?.get(input.companyId);
  if (!owners) {
    owners = listCompanyOwnerUserIds(db, input.companyId);
    cache?.set(input.companyId, owners);
  }
  for (const userId of await owners) {
    const found = await attempt(userId);
    if (found) return found;
  }
  return null;
}

/** Active human owners of the company (membership role `owner`), oldest first. */
async function listCompanyOwnerUserIds(db: OwnerDeliveryDb, companyId: string): Promise<string[]> {
  const rows = await db
    .select({ principalId: companyMemberships.principalId })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.status, "active"),
        eq(companyMemberships.membershipRole, "owner"),
      ),
    )
    .orderBy(asc(companyMemberships.createdAt), asc(companyMemberships.id));
  return rows.map((row) => row.principalId);
}

/**
 * myrmidon(1.6.5-OWNER-VIA-BOT): the standing Telegram DM conversation between
 * one agent and one board user — the lookup half of the U2 rules above, shared
 * with the owner-message tool (which writes into the same conversation).
 */
export async function findOwnerDmBindings(
  db: OwnerDeliveryDb,
  input: { companyId: string; ownerUserId: string; agentId: string },
): Promise<OwnerDeliveryBinding[]> {
  const createdByAgentId = input.agentId;
  const ownerUserId = input.ownerUserId;
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
