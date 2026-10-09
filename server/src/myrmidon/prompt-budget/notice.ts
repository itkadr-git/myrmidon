// server/src/myrmidon/prompt-budget/notice.ts
//
// myrmidon(1.6.5 PROMPT-BUDGET-SIGNAL): recognising the signal comments the
// 1.6.3 part left behind.
//
// Before this change every sweep wrote a system notice ("Prompt budget
// threshold crossed") into the agent's most recent in_progress task, and each
// one queued as a new message for that agent. The signal no longer writes
// comments, but the copies already in agent tasks are still in the thread,
// still in wake payloads and still in the queued-comment queue. This is the
// one place that answers "is this comment that old signal?" — the wake path
// and the queue read it, so those copies never wake an agent again.
//
// The comment's metadata is unreliable by construction (the port that wrote
// it dropped the metadata, which is exactly why the old dedup never matched),
// so the notice is recognised by its system presentation title with the body
// sentence as the fallback for a row whose presentation was lost too.

import {
  PROMPT_BUDGET_SIGNAL_NOTICE_TITLE,
  isPromptBudgetSignalNoticeBody,
} from "@paperclipai/shared";

/** The fields the notice test needs — a comment row, or a structural stand-in. */
export interface PromptBudgetNoticeCandidate {
  authorType?: string | null;
  presentation?: { kind?: string | null; title?: string | null } | null;
  body?: string | null;
}

/**
 * True when the comment is a prompt-budget signal notice: a system comment
 * carrying the signal's system_notice title, or — when the presentation did
 * not survive the insert — its opening sentence. A person's comment is never
 * one, whatever it quotes.
 */
export function isPromptBudgetSignalNotice(
  comment: PromptBudgetNoticeCandidate,
): boolean {
  if (comment.authorType !== "system") return false;
  const presentation = comment.presentation ?? null;
  if (
    presentation?.kind === "system_notice" &&
    presentation?.title === PROMPT_BUDGET_SIGNAL_NOTICE_TITLE
  ) {
    return true;
  }
  return isPromptBudgetSignalNoticeBody(comment.body);
}
