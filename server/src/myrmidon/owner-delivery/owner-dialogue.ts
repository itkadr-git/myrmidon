// server/src/myrmidon/owner-delivery/owner-dialogue.ts
//
// myrmidon(1.6.5-OWNER-VIA-BOT): the read side of the owner dialogue.
//
// In the default delivery mode (`via_bot`) the owner never gets a card with
// buttons. The agent that raised an owner decision writes the owner one plain
// message in the standing Telegram DM conversation, and the owner's text
// answer closes the interaction. This module answers three questions from the
// database alone (no new table):
//
//  - which open decisions of an agent wait for the owner (loadOpenOwnerDecisions);
//  - which of them the agent has already explained (listExplainedInteractions:
//    the explanation is an agent comment in the DM conversation issue whose
//    metadata rows name the interaction ids — the binding "the owner's next
//    text answer is about interaction X");
//  - what the agent's run prompt must say (buildOwnerViaBotPromptBlock).

import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  issueComments,
  issueThreadInteractions,
  issues,
  type Db,
} from "@paperclipai/db";
import {
  OWNER_MESSAGE_COMMENT_REASON,
  OWNER_MESSAGE_INTERACTION_LABEL,
  isOwnerDecisionAudience,
} from "@paperclipai/shared";
import { parseTelegramConversationUserId } from "../agent-chat-bridge/identity.js";

/** The interaction kinds the owner dialogue handles (the kinds that used to become cards). */
export const OWNER_DIALOGUE_KINDS = ["ask_user_questions", "request_confirmation"] as const;
export type OwnerDialogueKind = (typeof OWNER_DIALOGUE_KINDS)[number];

/** One open decision that waits for the task owner. */
export interface OwnerDecision {
  interactionId: string;
  issueId: string;
  issueIdentifier: string | null;
  issueTitle: string;
  kind: OwnerDialogueKind;
  ownerUserId: string;
  createdAt: Date;
  /** The interaction payload, unnarrowed; read it through the helpers below. */
  payload: unknown;
}

/** How a text answer may close an interaction of each kind. */
export const OWNER_REPLY_ACTIONS_BY_KIND: Record<OwnerDialogueKind, readonly string[]> = {
  ask_user_questions: ["respond"],
  request_confirmation: ["accept", "reject"],
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * A payload the text dialogue may close: no governed action behind it. A tool
 * action, a secret proposal or a connection authorization stays an explicit
 * decision on the board — a chat sentence never approves those.
 */
export function isPlainOwnerDecisionPayload(kind: string, payload: unknown): boolean {
  const record = asRecord(payload);
  if (!record) return false;
  if (kind === "ask_user_questions") {
    return Array.isArray(record.questions) && record.questions.length > 0;
  }
  if (kind === "request_confirmation") {
    return (
      record.toolAction === undefined &&
      record.secretProposal === undefined &&
      record.connectionAuthorization === undefined
    );
  }
  return false;
}

/**
 * The open (pending) decisions the agent raised for the task owner. A decision
 * qualifies when it is an owner-decision audience (human_only, or addressed to
 * the task owner), a plain question/confirmation, and lives on an ordinary
 * task — a conversation issue has its own routing.
 */
export async function loadOpenOwnerDecisions(
  db: Pick<Db, "select">,
  input: { companyId: string; agentId: string; interactionIds?: readonly string[] },
): Promise<OwnerDecision[]> {
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
      responsibleUserId: issues.responsibleUserId,
      issueCreatedByUserId: issues.createdByUserId,
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
        eq(issueThreadInteractions.createdByAgentId, input.agentId),
        eq(issueThreadInteractions.status, "pending"),
        inArray(issueThreadInteractions.kind, [...OWNER_DIALOGUE_KINDS]),
        input.interactionIds && input.interactionIds.length > 0
          ? inArray(issueThreadInteractions.id, [...input.interactionIds])
          : undefined,
      ),
    )
    .orderBy(asc(issueThreadInteractions.createdAt), asc(issueThreadInteractions.id))
    .limit(100);

  const decisions: OwnerDecision[] = [];
  for (const row of rows) {
    if (row.conversationAgentId) continue;
    const ownerUserId = row.responsibleUserId ?? row.issueCreatedByUserId ?? null;
    if (!ownerUserId) continue;
    if (
      !isOwnerDecisionAudience({
        effectiveResolverPolicy: row.effectiveResolverPolicy,
        addresseeAgentId: row.addresseeAgentId,
        addresseeUserId: row.addresseeUserId,
        ownerUserId,
      })
    ) {
      continue;
    }
    if (!isPlainOwnerDecisionPayload(row.kind, row.payload)) continue;
    decisions.push({
      interactionId: row.id,
      issueId: row.issueId,
      issueIdentifier: row.identifier,
      issueTitle: row.issueTitle,
      kind: row.kind as OwnerDialogueKind,
      ownerUserId,
      createdAt: row.createdAt,
      payload: row.payload,
    });
  }
  return decisions;
}

/** One agent message to the owner that explained some interactions. */
export interface OwnerExplanation {
  commentId: string;
  createdAt: Date;
  interactionIds: string[];
}

/**
 * The owner messages the agent wrote into one DM conversation issue, newest
 * first. The interaction ids come from the comment metadata rows the
 * owner-message tool stamps; nothing else counts as an explanation.
 */
export async function listOwnerExplanations(
  db: Pick<Db, "select">,
  input: { companyId: string; conversationIssueId: string; agentId: string; limit?: number },
): Promise<OwnerExplanation[]> {
  const rows = await db
    .select({
      id: issueComments.id,
      createdAt: issueComments.createdAt,
      metadata: issueComments.metadata,
    })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, input.companyId),
        eq(issueComments.issueId, input.conversationIssueId),
        eq(issueComments.authorAgentId, input.agentId),
        isNull(issueComments.deletedAt),
        sql`${issueComments.metadata} ->> 'authorizationReason' = ${OWNER_MESSAGE_COMMENT_REASON}`,
      ),
    )
    .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
    .limit(input.limit ?? 100);
  const explanations: OwnerExplanation[] = [];
  for (const row of rows) {
    const ids: string[] = [];
    for (const section of row.metadata?.sections ?? []) {
      for (const metaRow of section.rows) {
        if (metaRow.type === "key_value" && metaRow.label === OWNER_MESSAGE_INTERACTION_LABEL) {
          ids.push(metaRow.value);
        }
      }
    }
    if (ids.length > 0) {
      explanations.push({ commentId: row.id, createdAt: row.createdAt, interactionIds: ids });
    }
  }
  return explanations;
}

/** The metadata of the owner-message comment: one `Interaction` row per explained id. */
export function ownerMessageCommentMetadata(interactionIds: readonly string[], runId: string | null) {
  return {
    version: 1 as const,
    sourceRunId: runId,
    authorizationReason: OWNER_MESSAGE_COMMENT_REASON,
    sections: [
      {
        title: "Owner message",
        rows: interactionIds.map((id) => ({
          type: "key_value" as const,
          label: OWNER_MESSAGE_INTERACTION_LABEL,
          value: id,
        })),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Prompt text
// ---------------------------------------------------------------------------

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Human-readable lines for one decision, with the ids the agent needs to answer it. */
export function describeOwnerDecision(decision: OwnerDecision): string[] {
  const task = decision.issueIdentifier
    ? `${decision.issueIdentifier} "${clip(decision.issueTitle, 120)}"`
    : `"${clip(decision.issueTitle, 120)}"`;
  const lines = [`- interaction ${decision.interactionId} (${decision.kind}, task ${task})`];
  const payload = asRecord(decision.payload);
  if (!payload) return lines;
  if (decision.kind === "ask_user_questions") {
    const questions = Array.isArray(payload.questions) ? payload.questions : [];
    for (const raw of questions) {
      const question = asRecord(raw);
      if (!question) continue;
      const options = (Array.isArray(question.options) ? question.options : [])
        .map((option) => asRecord(option))
        .filter((option): option is Record<string, unknown> => option !== null)
        .map((option) => `${asString(option.id) ?? "?"} = ${clip(asString(option.label) ?? "", 80)}`);
      lines.push(
        `  question ${asString(question.id) ?? "?"} (${asString(question.selectionMode) ?? "single"}): ${clip(
          asString(question.prompt) ?? "",
          300,
        )}`,
      );
      if (options.length > 0) lines.push(`    options: ${options.join("; ")}`);
    }
  } else {
    lines.push(`  asks: ${clip(asString(payload.prompt) ?? "", 300)}`);
    const details = asString(payload.detailsMarkdown);
    if (details) lines.push(`  details: ${clip(details, 400)}`);
    lines.push(
      `  accept = "${asString(payload.acceptLabel) ?? "Accept"}", reject = "${asString(payload.rejectLabel) ?? "Reject"}"`,
    );
  }
  return lines;
}

/**
 * The block for a run that must EXPLAIN open decisions to the owner (the wake
 * created with the interaction). Empty when nothing is left to explain — a
 * second wake after the explanation went out is a no-op for the agent.
 */
export function ownerExplainPromptBlock(unexplained: readonly OwnerDecision[]): string {
  if (unexplained.length === 0) return "";
  const lines = [
    "## Owner decision waiting: explain it in a direct message",
    "",
    "The owner does not receive cards with buttons. These decisions were raised by you and wait for the owner:",
    ...unexplained.flatMap(describeOwnerDecision),
    "",
    "Do this now, once:",
    `1. Call \`myrmidonMessageOwner\` ONE time with \`interactionIds\` = [${unexplained
      .map((decision) => `"${decision.interactionId}"`)
      .join(", ")}] and \`text\` = a plain message to the owner, in the language the owner writes to you (Russian by default).`,
    "   The text must say: what has to be decided, why it matters now, every option with its consequence, your recommendation, and that a short reply is enough.",
    "   No internal ids, no tool or API names, no tables. With several decisions write ONE message with a short numbered summary.",
    "2. Do not repeat the message and do not close the interaction yourself. The owner's text answer reaches you in your direct chat with the owner, marked as an answer to the interaction.",
    "3. Then end the turn as usual; the task keeps waiting for the owner.",
  ];
  return lines.join("\n");
}

/**
 * The block for the turn in which the owner answered in the direct chat while
 * decisions that this agent explained are still open.
 */
export function ownerReplyPromptBlock(input: {
  open: readonly OwnerDecision[];
  ownerReplyCommentId: string;
}): string {
  if (input.open.length === 0) return "";
  const lines = [
    "## The owner's message may answer an open decision",
    "",
    "You explained these decisions to the owner and they are still open:",
    ...input.open.flatMap(describeOwnerDecision),
    "",
    `The owner's message of this turn is comment ${input.ownerReplyCommentId}.`,
    "- If it explicitly decides one of them, call `myrmidonResolveInteractionByOwnerReply` with `interactionId`, `ownerReplyCommentId` = that comment id, `action` and `body`, then tell the owner in one short sentence what you recorded.",
    "  Bodies: accept -> {} ; reject -> {\"reason\": \"...\"} ; respond (ask_user_questions) -> {\"answers\": [{\"questionId\": \"...\", \"optionIds\": [\"...\"], \"otherText\": null}]}.",
    "- If it is unclear, partial, or only a question back: answer in this chat with ONE short clarifying question and close nothing.",
    "- If it is about something else: answer it normally and close nothing.",
    "- Only the owner's explicit words in this dialogue close a decision. Never close one from silence, from your own reasoning, or from a message of another person.",
  ];
  return lines.join("\n");
}

/** The board user id behind a Telegram conversation issue, or null. */
export function telegramConversationOwner(
  issue: { conversationAgentId?: string | null; conversationUserId?: string | null } | null | undefined,
): string | null {
  if (!issue?.conversationAgentId) return null;
  return parseTelegramConversationUserId(issue.conversationUserId);
}
