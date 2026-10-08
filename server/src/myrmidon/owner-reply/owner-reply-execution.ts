// server/src/myrmidon/owner-reply/owner-reply-execution.ts
//
// myrmidon(1.6.5-F21-A): the default implementation of the owner-reply plan.
//
// This is the only file in the module that writes. It deliberately owns no
// resolution rules of its own: each step is a call to the service the board's
// own resolve routes call.
//  - closing a card goes through issueThreadInteractionService, the SAME service
//    the ordinary accept/reject/respond routes call, with the owner as the actor
//    (`userId` = the owner) and the durable continuation wake persisted through
//    interactionContinuationOutboxMutationOptions, so the task's agent is woken
//    with the answer exactly as it is for a board resolution;
//  - re-asking pushes the existing card again through the existing chat
//    publication outbox (enqueueIssueInteractionChatPublications) — the card's
//    own buttons, not a new message format;
//  - every write is recorded as a task comment whose metadata is the durable
//    mark ("this owner answer was seen, this card is still open"), which is also
//    what keeps the re-ask to one per owner answer.
//
// Nothing here fails the caller: the module is called from the owner's own
// comment route and from the inbound chat writer, so a defect must degrade to
// "the card stays pending", never to a failed owner write.

import { and, desc, eq, sql } from "drizzle-orm";
import {
  issueComments,
  issueThreadInteractions,
  issues,
  type Db,
} from "@paperclipai/db";
import {
  type IssueCommentMetadata,
  type OwnerDeliveryMode,
} from "@paperclipai/shared";
import { redactSensitiveText } from "../../redaction.js";
import { logActivity } from "../../services/activity-log.js";
import {
  enqueueIssueInteractionChatPublications,
} from "../../services/chat-interaction-publications.js";
import { issueThreadInteractionService } from "../../services/issue-thread-interactions.js";
import { interactionContinuationOutboxMutationOptions } from "../interaction-continuation-outbox.js";
import { readOwnerDeliveryMode } from "../owner-delivery/telegram-owner-bindings.js";
import {
  listPendingOwnerCardsForAgentDialogue,
  listPendingOwnerCardsForIssue,
  type PendingOwnerCard,
} from "./pending-owner-cards.js";
import type { OwnerReplyPendingReason } from "./owner-reply-plan.js";
import type {
  OwnerReplyDeps,
  OwnerReplyResolveInput,
} from "./owner-task-reply.js";

/** The metadata reason that marks a task comment as an owner-reply note. */
export const OWNER_REPLY_NOTE_REASON = "myrmidon_owner_reply_undecided";

/** The metadata key that ties a note to the owner answer it belongs to. */
export const OWNER_REPLY_ANSWER_KEY_FIELD = "ownerReplyAnswerKey";

type InteractionService = ReturnType<typeof issueThreadInteractionService>;
type InteractionIssueArg = Parameters<InteractionService["acceptInteraction"]>[0];
/** The same ref the resolution services take, plus the assignee the outbox
 * needs to decide whether the card's resolution wakes an agent. */
type IssueForResolution = InteractionIssueArg & { assigneeAgentId: string | null };
type AcceptBody = Parameters<InteractionService["acceptInteraction"]>[2];
type RejectBody = Parameters<InteractionService["rejectInteraction"]>[2];
type RespondBody = Parameters<InteractionService["answerQuestions"]>[2];

/**
 * The default deps: real lists, real resolution services, real chats.
 */
export function createOwnerReplyDeps(db: Db): OwnerReplyDeps {
  const interactionSvc = issueThreadInteractionService(db);

  const loadIssue = async (card: PendingOwnerCard): Promise<IssueForResolution | null> =>
    db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        projectId: issues.projectId,
        goalId: issues.goalId,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(and(eq(issues.companyId, card.companyId), eq(issues.id, card.issueId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);

  /**
   * The note's durable mark, in the shape this table takes: the reason plus one
   * key/value row per call-site mark, so a note never needs a wider column type
   * than the one the comments table already declares.
   */
  const noteMetadata = (marks: Record<string, unknown>): IssueCommentMetadata => ({
    version: 1,
    authorizationReason: OWNER_REPLY_NOTE_REASON,
    sections: [
      {
        title: OWNER_REPLY_NOTE_REASON,
        rows: Object.entries(marks).map(([label, value]) => ({
          type: "key_value" as const,
          label,
          value: Array.isArray(value) ? value.join(", ") : String(value),
        })),
      },
    ],
  });

  const noteComment = async (input: {
    companyId: string;
    issueId: string;
    agentId: string | null;
    runId: string | null;
    body: string;
    metadata: Record<string, unknown>;
  }): Promise<string | null> => {
    const now = new Date();
    const [comment] = await db
      .insert(issueComments)
      .values({
        companyId: input.companyId,
        issueId: input.issueId,
        authorAgentId: input.agentId,
        authorType: input.agentId ? "agent" : "system",
        createdByRunId: input.runId,
        body: redactSensitiveText(input.body).trim(),
        metadata: noteMetadata(input.metadata),
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: issueComments.id });
    return comment?.id ?? null;
  };

  const reaskCard = async (input: {
    card: PendingOwnerCard;
    ownerUserId: string;
    reason: OwnerReplyPendingReason;
    text: string;
    answerKey: string;
    runId: string | null;
  }): Promise<void> => {
    const [row] = await db
      .select({
        id: issueThreadInteractions.id,
        kind: issueThreadInteractions.kind,
        createdByAgentId: issueThreadInteractions.createdByAgentId,
      })
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, input.card.interactionId))
      .limit(1);
    await noteComment({
      companyId: input.card.companyId,
      issueId: input.card.issueId,
      agentId: row?.createdByAgentId ?? null,
      runId: input.runId,
      body: [
        "The owner answered in words and the card stays open.",
        "",
        `Owner reply: ${input.text}`,
        `Reason: ${input.reason}.`,
        "The question was sent again with its buttons; the owner may also tap an option.",
      ].join("\n"),
      metadata: {
        interactionId: input.card.interactionId,
        [OWNER_REPLY_ANSWER_KEY_FIELD]: input.answerKey,
        reask: true,
      },
    });
    // The card itself is re-pushed through the existing publication outbox, so
    // the owner gets the same buttons again rather than a new message format.
    try {
      const interaction = await interactionSvc.getForIssue(
        { id: input.card.issueId, companyId: input.card.companyId },
        input.card.interactionId,
      );
      await enqueueIssueInteractionChatPublications(db, interaction);
    } catch {
      // The mark above is the durable part; a card that cannot be re-pushed
      // (no chat binding, already superseded) does not fail the owner's write.
    }
  };
  const askWhichCard = async (input: {
    cards: readonly PendingOwnerCard[];
    ownerUserId: string;
    text: string;
    answerKey: string;
  }): Promise<void> => {
    const lines = input.cards.map(
      (card, index) =>
        `${index + 1}) ${card.issueIdentifier ? `${card.issueIdentifier}: ` : ""}${card.card.title ?? card.issueTitle}`,
    );
    const first = input.cards[0];
    if (!first) return;
    await noteComment({
      companyId: first.companyId,
      issueId: first.issueId,
      agentId: null,
      runId: null,
      body: [
        "Which question does the owner's answer belong to? Several owner cards are open:",
        "",
        ...lines,
        "",
        `Owner reply: ${input.text}`,
        "Every open card was sent again with its buttons.",
      ].join("\n"),
      metadata: {
        interactionIds: input.cards.map((card) => card.interactionId),
        [OWNER_REPLY_ANSWER_KEY_FIELD]: `${input.answerKey}:which`,
      },
    });
    for (const card of input.cards) {
      try {
        const interaction = await interactionSvc.getForIssue(
          { id: card.issueId, companyId: card.companyId },
          card.interactionId,
        );
        await enqueueIssueInteractionChatPublications(db, interaction);
      } catch {
        // Best effort, same as the single-card re-ask above.
      }
    }
  };

  const loadReaskMarks = async (input: {
    companyId: string;
    issueId: string | null;
    answerKey: string;
    cardIds: readonly string[];
  }): Promise<readonly string[]> => {
    if (input.cardIds.length === 0) return [];
    const rows = await db
      .select({ metadata: issueComments.metadata })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.companyId, input.companyId),
          input.issueId ? eq(issueComments.issueId, input.issueId) : sql`true`,
          sql`${issueComments.metadata} ->> 'authorizationReason' = ${OWNER_REPLY_NOTE_REASON}`,
          sql`${issueComments.metadata} ->> ${OWNER_REPLY_ANSWER_KEY_FIELD} = ${input.answerKey}`,
        ),
      )
      .orderBy(desc(issueComments.createdAt))
      .limit(50);
    const interactionIds = new Set<string>();
    for (const row of rows) {
      const metadata = row.metadata as Record<string, unknown> | null;
      const interactionId = metadata?.interactionId;
      if (typeof interactionId === "string") interactionIds.add(interactionId);
      for (const id of (metadata?.interactionIds as unknown[]) ?? []) {
        if (typeof id === "string") interactionIds.add(id);
      }
    }
    return [...interactionIds].filter((id) => input.cardIds.includes(id));
  };

  const resolveCard = async (input: OwnerReplyResolveInput): Promise<{ status: string }> => {
    const issue = await loadIssue(input.card);
    if (!issue) throw new Error(`issue not found for interaction ${input.card.interactionId}`);
    const [interaction] = await db
      .select({
        id: issueThreadInteractions.id,
        kind: issueThreadInteractions.kind,
        status: issueThreadInteractions.status,
        continuationPolicy: issueThreadInteractions.continuationPolicy,
        sourceCommentId: issueThreadInteractions.sourceCommentId,
        sourceRunId: issueThreadInteractions.sourceRunId,
      })
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, input.card.interactionId))
      .limit(1);
    if (!interaction) throw new Error(`interaction not found: ${input.card.interactionId}`);

    const mutationOptions = interactionContinuationOutboxMutationOptions({
      issue: { id: issue.id, companyId: issue.companyId, assigneeAgentId: issue.assigneeAgentId },
      interaction,
      idempotencyKey: `owner-reply:${input.sourceRef}:${interaction.id}`,
    });
    // The actor is the OWNER: same attribution the board resolution records,
    // resolvedAsUserId included, so the audit trail says who decided.
    const actor = {
      userId: input.ownerUserId,
      runId: input.runId,
      resolutionDetails: {
        resolvedAsUserId: input.ownerUserId,
        ownerReplyCommentId: input.replyCommentId,
        source: input.sourceRef,
      },
    };
    let status: string;
    if (input.action === "accept") {
      const accepted = await interactionSvc.acceptInteraction(
        issue,
        interaction.id,
        input.body as AcceptBody,
        actor as Parameters<InteractionService["acceptInteraction"]>[3],
        mutationOptions,
      );
      status = String(accepted.interaction.status ?? "accepted");
    } else if (input.action === "reject") {
      const rejected = await interactionSvc.rejectInteraction(
        issue,
        interaction.id,
        input.body as RejectBody,
        actor as Parameters<InteractionService["rejectInteraction"]>[3],
        mutationOptions,
      );
      status = String(rejected.status ?? "rejected");
    } else {
      const answered = await interactionSvc.answerQuestions(
        issue,
        interaction.id,
        input.body as RespondBody,
        actor as Parameters<InteractionService["answerQuestions"]>[3],
        mutationOptions,
      );
      status = String(answered.status ?? "answered");
    }

    await logActivity(db, {
      companyId: input.card.companyId,
      actorType: "user",
      actorId: input.ownerUserId,
      action: "owner_reply.resolution",
      entityType: "issue_thread_interaction",
      entityId: interaction.id,
      details: {
        issueId: input.card.issueId,
        interactionId: interaction.id,
        interactionKind: interaction.kind,
        action: input.action,
        status,
        resolvedAsUserId: input.ownerUserId,
        ownerReplyCommentId: input.replyCommentId,
        source: input.sourceRef,
      },
    }).catch(() => undefined);

    return { status };
  };

  return {
    readMode: (): Promise<OwnerDeliveryMode> => readOwnerDeliveryMode(db),
    listCards: (input) =>
      input.issueId
        ? listPendingOwnerCardsForIssue(db, {
            companyId: input.companyId,
            issueId: input.issueId,
            ownerUserId: input.ownerUserId,
            before: input.before,
          })
        : listPendingOwnerCardsForAgentDialogue(db, {
            companyId: input.companyId,
            agentId: input.agentId ?? "",
            ownerUserId: input.ownerUserId,
            before: input.before,
          }),
    loadReaskMarks,
    resolveCard,
    reaskCard,
    askWhichCard,
  };
}