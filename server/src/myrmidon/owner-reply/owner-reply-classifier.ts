// server/src/myrmidon/owner-reply/owner-reply-classifier.ts
//
// myrmidon(1.6.5-F21-A): the wording→decision mapping the inbound chat writer
// expects. The owner's own message in a task chat is closed by the writer in
// owner-delivery/owner-autoclose.ts, which leaves "what do these words mean" to
// a classifier; this is that classifier, and it is the same parse the task
// comment hook runs — so «2) да» means option 2 wherever the owner types it.
//
// It decides and nothing else: a sentence that carries no decision falls back to
// the writer's own free-text reading (a card that accepts a typed-in answer), and
// only when that too reads nothing does the writer report "unmappable_reply" and
// leave the card open for the owner's buttons (or the re-ask on the comment path).

import {
  classifyOwnerChatReplyByFreeText,
  type OwnerChatReplyClassifier,
} from "../owner-delivery/owner-autoclose.js";
import { ownerReplyCardFromPayload } from "./owner-reply-card.js";
import { parseOwnerReply } from "./parse-owner-reply.js";

/** The classifier the inbound owner-chat writer plugs in (F-21, part A). */
export const classifyOwnerReplyText: OwnerChatReplyClassifier = (input) => {
  const { kind, payload, replyText } = input;
  const card = ownerReplyCardFromPayload({ interactionId: "", kind, payload });
  const parsed = card ? parseOwnerReply({ text: replyText, card }) : null;
  if (parsed?.kind === "decision") {
    return parsed.decision === "accept" ? { action: "accept" } : { action: "reject" };
  }
  if (parsed?.kind === "selection") {
    return {
      action: "respond",
      answers: parsed.selections.map((selection) => ({
        questionId: selection.questionId,
        optionIds: [...selection.optionIds],
        ...(selection.otherText ? { otherText: selection.otherText } : {}),
      })),
      summaryMarkdown: null,
    };
  }
  // "comment" (words that decide nothing) and "unclear" (an answer that fits
  // nothing) are not this parser's answers to give: the writer's own free-text
  // reading gets the last word, exactly as it did before this module existed.
  return classifyOwnerChatReplyByFreeText(input);
};