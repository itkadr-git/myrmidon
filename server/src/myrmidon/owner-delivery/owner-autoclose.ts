// server/src/myrmidon/owner-delivery/owner-autoclose.ts
//
// myrmidon(1.6.5-F21-AUTOCLOSE): the owner's own message in the task's chat
// closes the single open owner decision of that task — without an agent run.
//
// Why this module exists. Closing an owner decision normally goes through
// authorizeOwnerReplyResolution (the guard of POST
// /api/myrmidon/owner-message/resolve), which requires a live owner DM, an
// agent message bound to the interaction and the owner's answer inside that
// DM — and it only ever runs from the author agent's live run. A card raised
// before the via_bot mode, and any card whose answer arrives as a plain
// sentence in the task's own chat, satisfies none of that, so it stayed pending
// until a human resolved it by hand.
//
// What happens here instead. The ingest of the owner's comment calls
// autoCloseOwnerDecisionOnOwnerComment; when exactly one open decision of that
// task belongs to the writer, the card is closed through the ordinary
// resolution path (issue-thread-interactions + the continuation outbox) with
// the owner as the acting user — the same thing the board would do if the owner
// had answered the card there. No agent run is needed, so the card no longer
// waits for one.
//
// Boundaries agreed with the lead (the F-21 split):
//  - turning the owner's words into a decision ("2) да" → accept/respond,
//    re-asking) is the owner-reply parser of OPE-6367. This module closes only
//    what the reply alone already decided: a single question the card itself
//    lets the owner answer in words (`allowOther`, or an option marked
//    `freeText`). Everything else — a closed select, a card with several
//    questions, a worded confirmation — stays pending for the parser;
//  - expired cards (pending longer than TTL) are OPE-6368;
//  - a card that hangs on an owner-DM conversation issue stays with the via-bot
//    path (owner-message.ts + routes.ts), because the answer there is bound to
//    the agent's explanation message, not to the task's chat.

import { and, desc, eq, inArray } from "drizzle-orm";
import {
  issueThreadInteractions,
  issues,
  type Db,
} from "@paperclipai/db";
import {
  isOwnerDecisionAudience,
  type IssueThreadInteractionCanonicalResolverPolicy,
  type SourceTrustMetadata,
} from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { logActivity } from "../../services/activity-log.js";
import { issueThreadInteractionService } from "../../services/issue-thread-interactions.js";
import { isIssueReviewVerdictInteraction } from "../../services/issue-review-policy.js";
import {
  interactionContinuationOutboxMutationOptions,
  interactionContinuationOutboxService,
} from "../interaction-continuation-outbox.js";
import {
  isPlainOwnerDecisionPayload,
  OWNER_DIALOGUE_KINDS,
  type OwnerDialogueKind,
} from "./owner-dialogue.js";

/** One answer to one question of an `ask_user_questions` card. */
export interface OwnerChatReplyAnswer {
  questionId: string;
  optionIds: string[];
  otherText?: string;
}

/**
 * The decision the owner's own words carry. `accept`/`reject` exist for the
 * classifier of a worded confirmation (OPE-6367); the default classifier below
 * deliberately produces neither, because a sentence cannot be turned into
 * "yes"/"no" without reading it.
 */
export type OwnerChatReplyResolution =
  | {
      action: "respond";
      answers: OwnerChatReplyAnswer[];
      summaryMarkdown: string | null;
    }
  | { action: "accept" }
  | { action: "reject" };

/** Turns the owner's sentence into a decision, or `null` when it cannot. */
export type OwnerChatReplyClassifier = (input: {
  kind: OwnerDialogueKind;
  payload: unknown;
  replyText: string;
}) => OwnerChatReplyResolution | null;

export type OwnerAutocloseSkipReason =
  /** the comment is not attributable to a linked member (quarantined origin). */
  | "reply_not_attributable"
  /** no open owner decision on the issue the comment landed on. */
  | "no_pending_decision"
  /** open decisions exist, but none of them waits for this writer. */
  | "not_the_owner"
  /** the writer is excluded from resolving as the card's own creator. */
  | "creator_excluded"
  /** the card bound to the writer is a review verdict, not an owner decision. */
  | "review_card"
  /** the writer's only card is bound to a governed action or a tool approval. */
  | "governed_payload"
  /** the writer owns more than one open decision: the parser re-asks (OPE-6367). */
  | "ambiguous_decisions"
  /** the comment predates the card it would close. */
  | "reply_not_after_decision"
  /** the wording needs the owner-reply parser (OPE-6367). */
  | "unmappable_reply"
  /** the resolution path itself refused (audience, policy, terminal issue). */
  | "resolution_refused";

export type OwnerAutocloseOutcome =
  | {
      outcome: "resolved";
      interactionId: string;
      issueId: string;
      kind: OwnerDialogueKind;
      action: "accept" | "reject" | "respond";
      interactionStatus: string;
      classifier: string;
    }
  | { outcome: "skipped"; reason: OwnerAutocloseSkipReason };

export interface OwnerAutocloseDeps {
  /**
   * Delivers the continuation wake of the closed card (post-commit). Omitted —
   * tests, or a caller without a dispatcher — the resolution still stands: the
   * wake intent persisted with it stays due and the outbox sweep retries it.
   */
  heartbeat?: Parameters<typeof interactionContinuationOutboxService>[1];
  /** Replaces the wording→decision mapping (OPE-6367 plugs its parser in here). */
  classifyReply?: OwnerChatReplyClassifier;
}

/** A pending owner decision of one issue, resolved to the user it waits for. */
interface OwnerDecisionCandidate {
  interactionId: string;
  issueId: string;
  kind: OwnerDialogueKind;
  payload: unknown;
  createdAt: Date;
  continuationPolicy: string;
  sourceCommentId: string | null;
  sourceRunId: string | null;
  effectiveResolverPolicy: IssueThreadInteractionCanonicalResolverPolicy;
  createdByUserId: string | null;
  createdByAgentId: string | null;
  addresseeAgentId: string | null;
  addresseeUserId: string | null;
  ownerUserId: string | null;
  reviewCard: boolean;
}

/**
 * The default mapping: one question the card itself lets the owner answer in
 * words. The card's own fields decide what "in words" means — `allowOther`, or
 * a single option marked `freeText` (the platform's inline-text choice, whose
 * typed value is returned as the question's `otherText`; see
 * chat-question-forms.ts, formKind). A closed select is NOT answered here: the
 * owner's "2)" must select option 2, and that is the owner-reply parser of
 * OPE-6367. The same parser owns a card with several questions, where one
 * sentence cannot be split between them.
 */
export const classifyOwnerChatReplyByFreeText: OwnerChatReplyClassifier = ({
  kind,
  payload,
  replyText,
}) => {
  if (kind !== "ask_user_questions") return null;
  const questions = readQuestions(payload);
  if (!questions || questions.length !== 1) return null;
  const question = questions[0]!;
  if (!question.acceptsTypedAnswer) return null;
  const text = normalizeReplyText(replyText);
  if (!text) return null;
  return {
    action: "respond",
    answers: [
      {
        questionId: question.id,
        optionIds: question.freeTextOptionId ? [question.freeTextOptionId] : [],
        otherText: text,
      },
    ],
    summaryMarkdown: text,
  };
};

/**
 * Closes the open owner decision of `issueId` that waits for the writer of an
 * inbound comment, when exactly one does and the comment carries the decision.
 * Never throws: every refusal is a reported skip, so the ingest path stays
 * untouched.
 */
export async function autoCloseOwnerDecisionOnOwnerComment(input: {
  db: Db;
  companyId: string;
  issueId: string;
  ownerUserId: string;
  commentId: string;
  replyText: string;
  commentCreatedAt: Date;
  /**
   * The comment's trust stamp. `null` is an ordinary, attributable owner
   * message; a stamp means the origin is not trusted (quarantined, or promoted
   * out of a low-trust source), so the words may not close anything — the same
   * rule the owner-DM guard applies in owner-message.ts.
   */
  commentSourceTrust?: SourceTrustMetadata | null;
  deps?: OwnerAutocloseDeps;
}): Promise<OwnerAutocloseOutcome> {
  try {
    if (input.commentSourceTrust) return skipped("reply_not_attributable");

    const candidates = await loadOwnerDecisionCandidates(input.db, {
      companyId: input.companyId,
      issueId: input.issueId,
    });
    if (candidates.length === 0) return skipped("no_pending_decision");

    // The cheap audience pre-check owner-dialogue uses for the DM branch: an
    // agent-addressed card is board-only, and a card that names no human only
    // counts under `human_only`.
    const addressed = candidates.filter(
      (row) =>
        row.addresseeAgentId === null &&
        isOwnerDecisionAudience({
          effectiveResolverPolicy: row.effectiveResolverPolicy,
          addresseeAgentId: row.addresseeAgentId,
          addresseeUserId: row.addresseeUserId,
          ownerUserId: row.ownerUserId,
        }),
    );
    const mine = addressed.filter((row) => row.ownerUserId === input.ownerUserId);
    if (mine.length === 0) return skipped("not_the_owner");

    const resolvable = mine.filter(
      (row) =>
        !(
          row.effectiveResolverPolicy === "not_creator" &&
          row.createdByUserId === input.ownerUserId
        ),
    );
    if (resolvable.length === 0) return skipped("creator_excluded");

    // A review verdict is resolved by the review flow, never by a sentence in
    // the task chat.
    const ownerDecisions = resolvable.filter((row) => !row.reviewCard);
    if (ownerDecisions.length === 0) return skipped("review_card");

    const plain = ownerDecisions.filter((row) =>
      isPlainOwnerDecisionPayload(row.kind, row.payload),
    );
    if (plain.length === 0) return skipped("governed_payload");

    // More than one open decision: the owner-reply parser asks again (OPE-6367).
    // Closing both from one sentence would answer cards the owner never saw.
    if (plain.length > 1) return skipped("ambiguous_decisions");

    const card = plain[0]!;
    if (card.createdAt.getTime() >= input.commentCreatedAt.getTime()) {
      return skipped("reply_not_after_decision");
    }

    const classifier = input.deps?.classifyReply ?? classifyOwnerChatReplyByFreeText;
    const resolution = classifier({
      kind: card.kind,
      payload: card.payload,
      replyText: input.replyText,
    });
    if (!resolution) return skipped("unmappable_reply");

    return await resolveOwnerDecision(input, card, resolution);
  } catch (err) {
    logger.warn(
      { err, issueId: input.issueId, commentId: input.commentId },
      "owner decision autoclose refused by the resolution path",
    );
    return skipped("resolution_refused");
  }
}

async function resolveOwnerDecision(
  input: {
    db: Db;
    companyId: string;
    ownerUserId: string;
    commentId: string;
    deps?: OwnerAutocloseDeps;
  },
  card: OwnerDecisionCandidate,
  resolution: OwnerChatReplyResolution,
): Promise<OwnerAutocloseOutcome> {
  const interactions = issueThreadInteractionService(input.db);
  const interactionStatus =
    resolution.action === "respond"
      ? "answered"
      : resolution.action === "accept"
        ? "accepted"
        : "rejected";
  const mutationOptions = interactionContinuationOutboxMutationOptions({
    issue: {
      id: card.issueId,
      companyId: input.companyId,
      assigneeAgentId: await loadIssueAssigneeAgentId(input.db, card.issueId),
    },
    interaction: {
      id: card.interactionId,
      kind: card.kind,
      status: interactionStatus,
      continuationPolicy: card.continuationPolicy,
      sourceCommentId: card.sourceCommentId,
      sourceRunId: card.sourceRunId,
    },
    idempotencyKey: `owner-chat-reply:${card.interactionId}:${input.commentId}`,
  });
  const issue = await loadIssueRef(input.db, card.issueId);
  // The owner as the acting user — the same actor a board click on the card
  // carries — so the resolver-policy audience check applies unchanged.
  const actor = { userId: input.ownerUserId };

  if (resolution.action === "respond") {
    await interactions.answerQuestions(
      issue,
      card.interactionId,
      { answers: resolution.answers, summaryMarkdown: resolution.summaryMarkdown },
      actor,
      mutationOptions,
    );
  } else if (resolution.action === "accept") {
    await interactions.acceptInteraction(
      issue,
      card.interactionId,
      {},
      actor,
      mutationOptions,
    );
  } else {
    await interactions.rejectInteraction(
      issue,
      card.interactionId,
      {},
      actor,
      mutationOptions,
    );
  }

  // The wake of the agent's continuation travels through the outbox, exactly as
  // after a board click: persisted with the resolution, delivered post-commit.
  if (input.deps?.heartbeat) {
    await interactionContinuationOutboxService(input.db, input.deps.heartbeat).tryDeliver(
      card.interactionId,
      interactionStatus,
    );
  }

  await logActivity(input.db, {
    companyId: input.companyId,
    entityType: "issue",
    entityId: card.issueId,
    action: "owner_reply.autoclose",
    actorType: "user",
    actorId: input.ownerUserId,
    details: {
      interactionId: card.interactionId,
      interactionKind: card.kind,
      interactionStatus,
      action: resolution.action,
      ownerReplyCommentId: input.commentId,
      classifier: input.deps?.classifyReply ? "custom" : "free_text",
    },
  }).catch((err: unknown) => {
    logger.warn(
      { err, issueId: card.issueId, interactionId: card.interactionId },
      "owner decision autoclose activity log failed",
    );
  });

  return {
    outcome: "resolved",
    interactionId: card.interactionId,
    issueId: card.issueId,
    kind: card.kind,
    action: resolution.action,
    interactionStatus,
    classifier: input.deps?.classifyReply ? "custom" : "free_text",
  };
}

/**
 * The open owner decisions of one issue, each with the user it waits for. The
 * sibling of loadOpenOwnerDecisions keyed by issue instead of by the authoring
 * agent: the inbound comment names the issue, not the agent that asked.
 */
async function loadOwnerDecisionCandidates(
  db: Db,
  input: { companyId: string; issueId: string },
): Promise<OwnerDecisionCandidate[]> {
  const rows = await db
    .select({
      interactionId: issueThreadInteractions.id,
      issueId: issueThreadInteractions.issueId,
      kind: issueThreadInteractions.kind,
      payload: issueThreadInteractions.payload,
      createdAt: issueThreadInteractions.createdAt,
      continuationPolicy: issueThreadInteractions.continuationPolicy,
      sourceCommentId: issueThreadInteractions.sourceCommentId,
      sourceRunId: issueThreadInteractions.sourceRunId,
      effectiveResolverPolicy: issueThreadInteractions.effectiveResolverPolicy,
      createdByUserId: issueThreadInteractions.createdByUserId,
      createdByAgentId: issueThreadInteractions.createdByAgentId,
      addresseeAgentId: issueThreadInteractions.addresseeAgentId,
      addresseeUserId: issueThreadInteractions.addresseeUserId,
      conversationAgentId: issues.conversationAgentId,
      issueTitle: issues.title,
      responsibleUserId: issues.responsibleUserId,
      issueCreatedByUserId: issues.createdByUserId,
      issueCreatedByAgentId: issues.createdByAgentId,
      issueReviewPolicy: issues.reviewPolicy,
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
      ),
    )
    .orderBy(desc(issueThreadInteractions.createdAt), desc(issueThreadInteractions.id))
    .limit(20);

  const candidates: OwnerDecisionCandidate[] = [];
  for (const row of rows) {
    // A conversation issue routes through its own bridge, not through the task.
    if (row.conversationAgentId) continue;
    const ownerUserId =
      row.addresseeUserId ?? row.responsibleUserId ?? row.issueCreatedByUserId ?? null;
    const reviewCard = await isIssueReviewVerdictInteraction(db, {
      issue: {
        id: row.issueId,
        companyId: input.companyId,
        reviewPolicy: row.issueReviewPolicy,
        createdByAgentId: row.issueCreatedByAgentId,
        createdByUserId: row.issueCreatedByUserId,
      },
      interaction: {
        id: row.interactionId,
        createdByAgentId: row.createdByAgentId,
        createdByUserId: row.createdByUserId,
      },
    });
    candidates.push({
      interactionId: row.interactionId,
      issueId: row.issueId,
      kind: row.kind as OwnerDialogueKind,
      payload: row.payload,
      createdAt: row.createdAt,
      continuationPolicy: row.continuationPolicy,
      sourceCommentId: row.sourceCommentId,
      sourceRunId: row.sourceRunId,
      effectiveResolverPolicy: row.effectiveResolverPolicy,
      createdByUserId: row.createdByUserId,
      createdByAgentId: row.createdByAgentId,
      addresseeAgentId: row.addresseeAgentId,
      addresseeUserId: row.addresseeUserId,
      ownerUserId,
      reviewCard,
    });
  }
  return candidates;
}

async function loadIssueRef(
  db: Db,
  issueId: string,
): Promise<{
  id: string;
  companyId: string;
  projectId: string | null;
  goalId: string | null;
  status?: string;
}> {
  const [row] = await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      projectId: issues.projectId,
      goalId: issues.goalId,
      status: issues.status,
    })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!row) throw new Error(`issue ${issueId} not found`);
  return row;
}

async function loadIssueAssigneeAgentId(
  db: Db,
  issueId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ assigneeAgentId: issues.assigneeAgentId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return row?.assigneeAgentId ?? null;
}

function readQuestions(
  payload: unknown,
): { id: string; acceptsTypedAnswer: boolean; freeTextOptionId: string | null }[] | null {
  if (!payload || typeof payload !== "object") return null;
  const questions = (payload as { questions?: unknown }).questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const parsed: {
    id: string;
    acceptsTypedAnswer: boolean;
    freeTextOptionId: string | null;
  }[] = [];
  for (const entry of questions) {
    if (!entry || typeof entry !== "object") return null;
    const record = entry as { id?: unknown; options?: unknown; allowOther?: unknown };
    if (typeof record.id !== "string" || record.id.length === 0) return null;
    const options = Array.isArray(record.options) ? record.options : [];
    const freeTextOption = options.find(
      (option): option is { id: string } =>
        Boolean(option) &&
        typeof option === "object" &&
        (option as { freeText?: unknown }).freeText === true &&
        typeof (option as { id?: unknown }).id === "string",
    );
    parsed.push({
      id: record.id,
      acceptsTypedAnswer: record.allowOther === true || Boolean(freeTextOption),
      freeTextOptionId: freeTextOption?.id ?? null,
    });
  }
  return parsed;
}

function normalizeReplyText(replyText: string): string | null {
  const text = replyText.trim();
  if (!text) return null;
  // The answer is stored on the interaction and replayed into the agent's
  // context; keep it to the size a decision answer is allowed to have.
  return text.slice(0, 4000);
}

function skipped(reason: OwnerAutocloseSkipReason): OwnerAutocloseOutcome {
  return { outcome: "skipped", reason };
}