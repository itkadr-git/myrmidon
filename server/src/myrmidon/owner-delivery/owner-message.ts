// server/src/myrmidon/owner-delivery/owner-message.ts
//
// myrmidon(1.6.5-OWNER-VIA-BOT): the write side of the owner dialogue.
//
//  - scheduleOwnerExplainWake: when an agent raises an owner decision, wake it
//    on that task with the open decision as context, to explain it to the owner;
//  - sendOwnerMessage: the outgoing channel — an agent writes the owner one
//    message in the standing Telegram DM conversation, bound to the
//    interactions it explains; only the author of an open owner decision may;
//  - authorizeOwnerReplyResolution: the guard of the closing step — the
//    owner's own text answer, bound to the explained interaction, is the only
//    evidence that lets the agent close a human-only interaction on the
//    owner's behalf.
//
// No new table: the binding "this message explains interaction X" is the
// metadata of the agent comment written into the DM conversation issue (see
// owner-dialogue.ts).

import { and, eq, inArray } from "drizzle-orm";
import {
  agentWakeupRequests,
  chatMessageLinks,
  chatPublications,
  heartbeatRuns,
  issueComments,
  type Db,
} from "@paperclipai/db";
import { OWNER_REPLY_RESOLUTION_ACTIONS, type OwnerReplyResolution } from "@paperclipai/shared";
import { conflict, forbidden, unprocessable } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { redactSensitiveText } from "../../redaction.js";
import { logActivity } from "../../services/activity-log.js";
import { OWNER_EXPLAIN_WAKE_SOURCE } from "../../modules/run-dispatch/myrmidon-pending-interaction-wake.js";
import { projectSafeChatPublication } from "../../services/chat-publication-projection.js";
import {
  OWNER_REPLY_ACTIONS_BY_KIND,
  loadOpenOwnerDecisions,
  listOwnerExplanations,
  ownerExplainPromptBlock,
  ownerMessageCommentMetadata,
  ownerReplyPromptBlock,
  describeOwnerDecision,
  telegramConversationOwner,
  type OwnerDecision,
} from "./owner-dialogue.js";
import { findOwnerDmBindings, readOwnerDeliveryMode } from "./telegram-owner-bindings.js";

/** The shape of `heartbeat.wakeup` the scheduler needs. */
export type OwnerExplainWakeup = (
  agentId: string,
  options: {
    source: "automation";
    triggerDetail: "system";
    reason: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
    requestedByActorType: "user" | "agent" | "system";
    requestedByActorId: string;
    contextSnapshot: Record<string, unknown>;
  },
) => Promise<unknown>;

/** The fields of a freshly created interaction the scheduler reads. */
export interface OwnerExplainInteraction {
  id: string;
  kind: string;
  status: string;
  createdByAgentId?: string | null;
}

export type OwnerExplainWakeOutcome =
  | "woken"
  | "skipped_not_pending"
  | "skipped_mode"
  | "skipped_not_owner_decision"
  | "skipped_no_owner_dm";

/**
 * Wakes the author of a new owner decision on its task, with the decision as
 * context, so that it explains the decision to the owner. Does nothing outside
 * the `via_bot` mode, for decisions that are not owner decisions, and when the
 * owner has no direct chat with the author (no channel to explain in).
 */
export async function scheduleOwnerExplainWake(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    interaction: OwnerExplainInteraction;
    wakeup: OwnerExplainWakeup;
    requestedBy: { actorType: "user" | "agent" | "system"; actorId: string };
  },
): Promise<OwnerExplainWakeOutcome> {
  const { interaction } = input;
  const agentId = interaction.createdByAgentId ?? null;
  if (interaction.status !== "pending" || !agentId) return "skipped_not_pending";
  if ((await readOwnerDeliveryMode(db)) !== "via_bot") return "skipped_mode";
  const [decision] = await loadOpenOwnerDecisions(db, {
    companyId: input.companyId,
    agentId,
    interactionIds: [interaction.id],
  });
  if (!decision) return "skipped_not_owner_decision";
  const [binding] = await findOwnerDmBindings(db, {
    companyId: input.companyId,
    ownerUserId: decision.ownerUserId,
    agentId,
  });
  if (!binding) return "skipped_no_owner_dm";
  await input.wakeup(agentId, {
    source: "automation",
    triggerDetail: "system",
    reason: "interaction_pending",
    payload: {
      issueId: input.issueId,
      interactionId: interaction.id,
      interactionKind: interaction.kind,
      mutation: "interaction",
      ownerExplain: true,
    },
    idempotencyKey: `owner-explain:${interaction.id}`,
    requestedByActorType: input.requestedBy.actorType,
    requestedByActorId: input.requestedBy.actorId,
    contextSnapshot: {
      issueId: input.issueId,
      taskId: input.issueId,
      interactionId: interaction.id,
      interactionKind: interaction.kind,
      wakeReason: "interaction_pending",
      source: OWNER_EXPLAIN_WAKE_SOURCE,
      ownerExplainInteractionId: interaction.id,
    },
  });
  return "woken";
}

/** The run the agent calls from must be a live run of that very agent. */
async function assertActiveAgentRun(
  db: Pick<Db, "select">,
  input: { companyId: string; agentId: string; runId: string | null },
): Promise<void> {
  if (!input.runId) throw forbidden("An active agent run is required");
  const [run] = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.id, input.runId),
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
        eq(heartbeatRuns.status, "running"),
      ),
    )
    .limit(1);
  if (!run) throw forbidden("The calling run is not an active run of this agent");
}

export interface OwnerMessageResult {
  commentId: string;
  publicationId: string;
  conversationIssueId: string;
  interactionIds: string[];
}

/**
 * The outgoing channel: writes the owner one message in the standing Telegram
 * DM conversation with the calling agent, bound to the interactions it
 * explains. Rules, all enforced here and not by the caller's good manners:
 *
 *  - only the AUTHOR of an open owner decision may write about it (a stranger
 *    gets 403, as does a decision that is no longer open);
 *  - one message per question: an interaction that was already explained gets
 *    409, and the message must cover EVERY other open, still unexplained
 *    decision for the same owner (409 `summary_required` lists what is
 *    missing) — several open questions become one summary, never a stream.
 */
export async function sendOwnerMessage(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    runId: string | null;
    interactionIds: readonly string[];
    text: string;
  },
): Promise<OwnerMessageResult> {
  await assertActiveAgentRun(db, input);
  const requested = [...new Set(input.interactionIds)];
  const decisions = await loadOpenOwnerDecisions(db, {
    companyId: input.companyId,
    agentId: input.agentId,
    interactionIds: requested,
  });
  if (decisions.length !== requested.length) {
    const known = new Set(decisions.map((decision) => decision.interactionId));
    throw forbidden(
      "Only the agent that raised an open owner decision can message the owner about it",
      { code: "not_author_of_open_owner_decision", rejectedInteractionIds: requested.filter((id) => !known.has(id)) },
    );
  }
  const ownerUserId = decisions[0]!.ownerUserId;
  if (decisions.some((decision) => decision.ownerUserId !== ownerUserId)) {
    throw unprocessable("The decisions belong to different owners; write one message per owner", {
      code: "different_owners",
    });
  }
  if ((await readOwnerDeliveryMode(db)) !== "via_bot") {
    throw conflict("The owner delivery mode is not via_bot; the owner receives cards instead", {
      code: "owner_delivery_mode",
    });
  }
  const [binding] = await findOwnerDmBindings(db, {
    companyId: input.companyId,
    ownerUserId,
    agentId: input.agentId,
  });
  if (!binding) {
    throw conflict("The owner has no live direct Telegram chat with this agent", { code: "no_owner_dm" });
  }
  const conversationIssueId = binding.conversation.issueId;

  const explanations = await listOwnerExplanations(db, {
    companyId: input.companyId,
    conversationIssueId,
    agentId: input.agentId,
  });
  const explained = new Set(explanations.flatMap((entry) => entry.interactionIds));
  const alreadyExplained = requested.filter((id) => explained.has(id));
  if (alreadyExplained.length > 0) {
    throw conflict(
      "The owner was already told about this decision; one message per question. Wait for the owner's answer.",
      { code: "already_explained", interactionIds: alreadyExplained },
    );
  }
  const openForOwner = (
    await loadOpenOwnerDecisions(db, { companyId: input.companyId, agentId: input.agentId })
  ).filter((decision) => decision.ownerUserId === ownerUserId);
  const missing = openForOwner.filter(
    (decision) => !explained.has(decision.interactionId) && !requested.includes(decision.interactionId),
  );
  if (missing.length > 0) {
    throw conflict(
      "Other open decisions for the same owner are still unexplained; cover all of them in this one message",
      {
        code: "summary_required",
        missing: missing.map((decision) => ({
          interactionId: decision.interactionId,
          description: describeOwnerDecision(decision).join("\n"),
        })),
      },
    );
  }

  const body = redactSensitiveText(input.text).trim();
  const publicationPayload = projectSafeChatPublication({
    classification: "external",
    source: "agent_comment",
    text: body,
  });
  const now = new Date();
  const result = await db.transaction(async (tx) => {
    const [comment] = await tx
      .insert(issueComments)
      .values({
        companyId: input.companyId,
        issueId: conversationIssueId,
        authorAgentId: input.agentId,
        authorType: "agent",
        createdByRunId: input.runId,
        body,
        metadata: ownerMessageCommentMetadata(requested, input.runId),
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: issueComments.id });
    const [publication] = await tx
      .insert(chatPublications)
      .values({
        companyId: input.companyId,
        endpointId: binding.endpoint.id,
        conversationId: binding.conversation.id,
        issueId: conversationIssueId,
        commentId: comment!.id,
        idempotencyKey: `owner-message:${comment!.id}:${binding.endpoint.id}`,
        payload: publicationPayload,
        state: "pending",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: chatPublications.id });
    return { commentId: comment!.id, publicationId: publication!.id };
  });
  try {
    await logActivity(db, {
      companyId: input.companyId,
      actorType: "agent",
      actorId: input.agentId,
      agentId: input.agentId,
      runId: input.runId,
      action: "owner_message.sent",
      entityType: "issue",
      entityId: conversationIssueId,
      details: { interactionIds: requested, commentId: result.commentId, publicationId: result.publicationId },
    });
  } catch (err) {
    // The audit row is secondary: the message is already durable.
    logger.warn({ err, commentId: result.commentId }, "owner message activity log failed");
  }
  // myrmidon(1.6.5-OWNER-FALLBACK): the author explained the decision in the run
  // that raised it, so the "explain" wake deferred behind that run has nothing
  // left to do. Best effort: if it already ran or was merged into another
  // deferred wake, its prompt block is empty (the decision is explained).
  try {
    await db
      .update(agentWakeupRequests)
      .set({ status: "cancelled", finishedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(agentWakeupRequests.companyId, input.companyId),
          eq(agentWakeupRequests.agentId, input.agentId),
          eq(agentWakeupRequests.status, "deferred_issue_execution"),
          inArray(
            agentWakeupRequests.idempotencyKey,
            requested.map((id) => `owner-explain:${id}`),
          ),
        ),
      );
  } catch (err) {
    logger.warn({ err, commentId: result.commentId }, "could not cancel the deferred owner-explain wake");
  }
  return { ...result, conversationIssueId, interactionIds: requested };
}

/** What the resolve guard hands back to the route. */
export interface OwnerReplyAuthorization {
  ownerUserId: string;
  issueId: string;
  interactionId: string;
  action: OwnerReplyResolution["action"];
  conversationIssueId: string;
  ownerReplyCommentId: string;
}

/**
 * The guard of the closing step. The agent may close a human-only
 * interaction on the owner's behalf only when ALL hold:
 *
 *  - the caller is the author of the open owner decision and calls from its own
 *    live run;
 *  - the action fits the interaction kind (accept/reject for a confirmation,
 *    respond for a question form) and no governed action stands behind it;
 *  - an owner message of this agent is bound to the interaction;
 *  - `ownerReplyCommentId` is a comment the OWNER wrote in that very DM
 *    conversation, AFTER the bound message, that arrived from Telegram
 *    (an inbound chat link exists) and is not quarantined.
 *
 * The returned owner id is the actor the route closes the interaction as: the
 * resolution is attributed to the owner, never to the agent.
 */
export async function authorizeOwnerReplyResolution(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    runId: string | null;
    resolution: OwnerReplyResolution;
  },
): Promise<OwnerReplyAuthorization> {
  await assertActiveAgentRun(db, input);
  const { resolution } = input;
  if (!(OWNER_REPLY_RESOLUTION_ACTIONS as readonly string[]).includes(resolution.action)) {
    throw unprocessable("Unknown resolution action");
  }
  const [decision] = await loadOpenOwnerDecisions(db, {
    companyId: input.companyId,
    agentId: input.agentId,
    interactionIds: [resolution.interactionId],
  });
  if (!decision) {
    throw forbidden("Only the author of an open owner decision can close it from the owner's answer", {
      code: "not_author_of_open_owner_decision",
    });
  }
  if (!OWNER_REPLY_ACTIONS_BY_KIND[decision.kind].includes(resolution.action)) {
    throw unprocessable(`Action ${resolution.action} does not fit a ${decision.kind} interaction`, {
      code: "action_kind_mismatch",
      allowed: OWNER_REPLY_ACTIONS_BY_KIND[decision.kind],
    });
  }
  const [binding] = await findOwnerDmBindings(db, {
    companyId: input.companyId,
    ownerUserId: decision.ownerUserId,
    agentId: input.agentId,
  });
  if (!binding) {
    throw conflict("The owner has no live direct Telegram chat with this agent", { code: "no_owner_dm" });
  }
  const conversationIssueId = binding.conversation.issueId;
  const explanation = (
    await listOwnerExplanations(db, {
      companyId: input.companyId,
      conversationIssueId,
      agentId: input.agentId,
    })
  ).find((entry) => entry.interactionIds.includes(decision.interactionId));
  if (!explanation) {
    throw conflict("No message to the owner is bound to this interaction", { code: "not_explained" });
  }

  const [reply] = await db
    .select({
      id: issueComments.id,
      issueId: issueComments.issueId,
      authorType: issueComments.authorType,
      authorUserId: issueComments.authorUserId,
      authorAgentId: issueComments.authorAgentId,
      sourceTrust: issueComments.sourceTrust,
      deletedAt: issueComments.deletedAt,
      createdAt: issueComments.createdAt,
    })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.id, resolution.ownerReplyCommentId),
        eq(issueComments.companyId, input.companyId),
      ),
    )
    .limit(1);
  const isOwnersAnswer =
    reply !== undefined &&
    reply.issueId === conversationIssueId &&
    reply.authorType === "user" &&
    reply.authorUserId === decision.ownerUserId &&
    reply.authorAgentId === null &&
    reply.sourceTrust === null &&
    reply.deletedAt === null &&
    reply.createdAt.getTime() > explanation.createdAt.getTime();
  if (!isOwnersAnswer) {
    throw forbidden(
      "ownerReplyCommentId is not the owner's answer to the bound message in the direct chat",
      { code: "no_owner_reply" },
    );
  }
  const [inbound] = await db
    .select({ id: chatMessageLinks.id })
    .from(chatMessageLinks)
    .where(
      and(
        eq(chatMessageLinks.companyId, input.companyId),
        eq(chatMessageLinks.commentId, resolution.ownerReplyCommentId),
        eq(chatMessageLinks.direction, "inbound"),
      ),
    )
    .limit(1);
  if (!inbound) {
    throw forbidden("The owner's answer did not arrive through the direct chat", { code: "no_owner_reply" });
  }
  return {
    ownerUserId: decision.ownerUserId,
    issueId: decision.issueId,
    interactionId: decision.interactionId,
    action: resolution.action,
    conversationIssueId,
    ownerReplyCommentId: resolution.ownerReplyCommentId,
  };
}

/**
 * The prompt block for a run, or "" when the owner dialogue has nothing to say
 * to it. Two cases:
 *
 *  - a run on an ordinary task woken by the owner-explain wake: the open,
 *    still unexplained decisions the agent must explain in ONE message;
 *  - a turn of the agent's Telegram DM conversation with the owner whose wake
 *    comment is the owner's message while explained decisions are still open:
 *    the note "this message answers interaction X" and how to close it.
 */
export async function buildOwnerViaBotPromptBlock(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    issue: { id: string; conversationAgentId?: string | null; conversationUserId?: string | null } | null;
    ownerExplainInteractionId: string | null;
    wakeCommentId: string | null;
  },
): Promise<string> {
  try {
    if (!input.issue) return "";
    const conversationOwner = telegramConversationOwner(input.issue);
    // Cheap exits first: most runs are neither an owner-explain wake nor a turn
    // of an agent's Telegram DM conversation with a wake message.
    if (!conversationOwner && !input.ownerExplainInteractionId) return "";
    if (conversationOwner && (!input.wakeCommentId || input.issue.conversationAgentId !== input.agentId)) return "";
    if ((await readOwnerDeliveryMode(db)) !== "via_bot") return "";
    if (!conversationOwner) {
      if (!input.ownerExplainInteractionId) return "";
      const [target] = await loadOpenOwnerDecisions(db, {
        companyId: input.companyId,
        agentId: input.agentId,
        interactionIds: [input.ownerExplainInteractionId],
      });
      if (!target) return "";
      const [binding] = await findOwnerDmBindings(db, {
        companyId: input.companyId,
        ownerUserId: target.ownerUserId,
        agentId: input.agentId,
      });
      if (!binding) return "";
      const explained = new Set(
        (
          await listOwnerExplanations(db, {
            companyId: input.companyId,
            conversationIssueId: binding.conversation.issueId,
            agentId: input.agentId,
          })
        ).flatMap((entry) => entry.interactionIds),
      );
      const unexplained = (
        await loadOpenOwnerDecisions(db, { companyId: input.companyId, agentId: input.agentId })
      ).filter((decision) => decision.ownerUserId === target.ownerUserId && !explained.has(decision.interactionId));
      return ownerExplainPromptBlock(unexplained);
    }

    // The agent's own Telegram DM conversation with the owner.
    if (!input.wakeCommentId) return "";
    const [wakeComment] = await db
      .select({
        authorUserId: issueComments.authorUserId,
        authorAgentId: issueComments.authorAgentId,
        sourceTrust: issueComments.sourceTrust,
      })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.id, input.wakeCommentId),
          eq(issueComments.companyId, input.companyId),
          eq(issueComments.issueId, input.issue.id),
        ),
      )
      .limit(1);
    if (
      !wakeComment ||
      wakeComment.authorAgentId !== null ||
      wakeComment.authorUserId !== conversationOwner ||
      wakeComment.sourceTrust !== null
    ) {
      return "";
    }
    const explained = new Set(
      (
        await listOwnerExplanations(db, {
          companyId: input.companyId,
          conversationIssueId: input.issue.id,
          agentId: input.agentId,
        })
      ).flatMap((entry) => entry.interactionIds),
    );
    if (explained.size === 0) return "";
    const open: OwnerDecision[] = (
      await loadOpenOwnerDecisions(db, { companyId: input.companyId, agentId: input.agentId })
    ).filter((decision) => decision.ownerUserId === conversationOwner && explained.has(decision.interactionId));
    return ownerReplyPromptBlock({ open, ownerReplyCommentId: input.wakeCommentId });
  } catch (err) {
    // A prompt hint must never fail a run.
    logger.warn({ err, issueId: input.issue?.id }, "owner dialogue prompt block unavailable for this turn");
    return "";
  }
}

/** Appends the owner-dialogue block to a task markdown, unchanged when the block is empty. */
export function appendOwnerViaBotBlock(markdown: string, block: string): string {
  return block ? `${markdown}\n\n${block}` : markdown;
}
