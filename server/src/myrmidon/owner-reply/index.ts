// server/src/myrmidon/owner-reply/index.ts
//
// myrmidon(1.6.5-F21-A): the module's public surface — the only file other
// slices import from.
//
// This barrel is the contract with the sibling work that consumes the owner
// reply path (part B): it may read the types, the parser and the card selection
// from here, and it must not edit the modules below. Nothing in this module
// throws at the caller and nothing here resolves an interaction outside the
// ordinary resolution services.

/** The phrase tables, the card view and the pure parser. */
export {
  OWNER_REPLY_CARD_KINDS,
  normalizeOwnerReplyText,
  ownerReplyAccepts,
  ownerReplyMentionsRecommendation,
  ownerReplyRejects,
  parseOwnerReply,
} from "./parse-owner-reply.js";
export type {
  OwnerReplyCard,
  OwnerReplyCardKind,
  OwnerReplyOptionCard,
  OwnerReplyParse,
  OwnerReplyQuestionCard,
  OwnerReplySelection,
  OwnerReplyUnclearReason,
} from "./parse-owner-reply.js";

/** A stored interaction payload, as far as the parser needs it. */
export { ownerReplyCardFromPayload } from "./owner-reply-card.js";

/** Which pending card of the owner a sentence may close. */
export {
  listPendingOwnerCardsForAgentDialogue,
  listPendingOwnerCardsForIssue,
} from "./pending-owner-cards.js";
export type { PendingOwnerCard } from "./pending-owner-cards.js";

/** The decision, as a value, before anything is written. */
export { planOwnerReply } from "./owner-reply-plan.js";
export type {
  OwnerReplyPendingReason,
  OwnerReplyPlan,
  OwnerReplyPlanInput,
} from "./owner-reply-plan.js";

/** The door: one entry point for both the web comment and the chat message. */
export { handleOwnerTextReply } from "./owner-task-reply.js";
export type {
  OwnerReplyDeps,
  OwnerReplyInput,
  OwnerReplyOutcome,
  OwnerReplyResolveInput,
} from "./owner-task-reply.js";

/** The default writer, for a route or a chat channel to install. */
export {
  createOwnerReplyDeps,
  OWNER_REPLY_ANSWER_KEY_FIELD,
  OWNER_REPLY_NOTE_REASON,
} from "./owner-reply-execution.js";

/** The wording→decision mapping the inbound owner-chat writer plugs in. */
export { classifyOwnerReplyText } from "./owner-reply-classifier.js";

// myrmidon(1.6.5-F21-B): TTL sweep, attention and settings exports (separate lines).
export {
  createOwnerCardTtlSweep,
  createOwnerCardTtlScheduler,
  classifyOwnerCardPayload,
  ownerCardResolvesBySilence,
  isExpiredOwnerCardRow,
  buildOwnerCardPayloadWithDelivery,
  OWNER_CARD_EXPIRED_WAKE_REASON,
  OWNER_CARD_EXPIRED_WAKE_IDEMPOTENCY_PREFIX,
  OWNER_CARD_SWEEP_SYSTEM_ID,
  OWNER_CARD_TTL_ACTIVITY_ACTION,
  OWNER_CARD_EXPIRED_COMMENT,
  OWNER_CARD_SILENCE_RESOLVED_COMMENT,
  OWNER_CARD_GUARDED_DECISION_CLASSES,
  type OwnerCardPayloadClass,
  type OwnerCardGuardedDecisionClass,
  type OwnerCardDeliveryMeta,
  type OwnerCardTtlRow,
  type OwnerCardTtlSweepDeps,
  type OwnerCardTtlSweepResult,
} from "./ttl-sweep.js";
export {
  summarizeOwnerPendingCards,
  ownerCardsAttentionDedupKey,
  ownerCardsAttentionTitle,
  ownerCardsAttentionWhyNow,
  type OwnerPendingCardsSummary,
} from "./attention.js";
export {
  readOwnerCardTtlSettings,
  OWNER_CARD_TTL_MS_ENV,
  OWNER_CARD_SWEEP_INTERVAL_SEC_ENV,
  OWNER_CARD_SWEEP_WAKE_BUDGET_ENV,
  OWNER_CARD_STALE_AGE_MS,
  DEFAULT_OWNER_CARD_TTL_MS,
  DEFAULT_OWNER_CARD_SWEEP_INTERVAL_SEC,
  DEFAULT_OWNER_CARD_SWEEP_PAGE_SIZE,
  DEFAULT_OWNER_CARD_SWEEP_WAKE_BUDGET,
  type OwnerCardTtlSettings,
} from "./settings.js";
