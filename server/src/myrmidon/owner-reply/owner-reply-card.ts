// server/src/myrmidon/owner-reply/owner-reply-card.ts
//
// myrmidon(1.6.5-F21-A): build the parser's card view from a stored interaction
// payload. Pure, no I/O: the same payload the board renders is read here, but
// only the human-facing fields (prompt, labels, options) reach the parser — the
// parser never needs an internal id beyond the ones it echoes back in an answer.
//
// The shape is intentionally permissive: a card written by an older build may
// lack a field, and a missing field must never throw. Anything unreadable is
// simply not offered to the owner.

import type { OwnerReplyCard, OwnerReplyCardKind, OwnerReplyOptionCard, OwnerReplyQuestionCard } from "./parse-owner-reply.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function readOption(raw: unknown): OwnerReplyOptionCard | null {
  const option = asRecord(raw);
  if (!option) return null;
  const id = asString(option.id);
  if (!id) return null;
  return {
    id,
    label: asString(option.label) ?? id,
    recommended: asBoolean(option.recommended),
    freeText: asBoolean(option.freeText),
  };
}

function readQuestion(raw: unknown): OwnerReplyQuestionCard | null {
  const question = asRecord(raw);
  if (!question) return null;
  const id = asString(question.id);
  if (!id) return null;
  const options = (Array.isArray(question.options) ? question.options : [])
    .map(readOption)
    .filter((option): option is OwnerReplyOptionCard => option !== null);
  return {
    id,
    prompt: asString(question.prompt) ?? "",
    selectionMode: question.selectionMode === "multi" ? "multi" : "single",
    options,
  };
}

/**
 * The card view of one stored interaction payload. Returns null when the
 * payload is not a plain owner decision (governed actions stay on the board) or
 * when the kind is not one a text answer may close.
 */
export function ownerReplyCardFromPayload(input: {
  interactionId: string;
  kind: string;
  payload: unknown;
}): OwnerReplyCard | null {
  if (input.kind !== "ask_user_questions" && input.kind !== "request_confirmation") return null;
  const payload = asRecord(input.payload);
  if (!payload) return null;
  const kind = input.kind as OwnerReplyCardKind;
  if (kind === "ask_user_questions") {
    const questions = (Array.isArray(payload.questions) ? payload.questions : [])
      .map(readQuestion)
      .filter((question): question is OwnerReplyQuestionCard => question !== null);
    if (questions.length === 0) return null;
    return {
      interactionId: input.interactionId,
      kind,
      title: asString(payload.title),
      questions,
      acceptLabel: null,
      rejectLabel: null,
    };
  }
  // request_confirmation: a governed action, a secret or a connection
  // authorization is never closed by a chat sentence.
  if (
    payload.toolAction !== undefined ||
    payload.secretProposal !== undefined ||
    payload.connectionAuthorization !== undefined
  ) {
    return null;
  }
  return {
    interactionId: input.interactionId,
    kind,
    title: asString(payload.title),
    questions: [],
    acceptLabel: asString(payload.acceptLabel),
    rejectLabel: asString(payload.rejectLabel),
  };
}