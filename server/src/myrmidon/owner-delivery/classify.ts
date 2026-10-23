// myrmidon(1.6.5-OWNER-DM-FILTER): shared classification of owner-DM chat
// publications. The delivery journal (part C) labels each entry with it; the
// verdict itself comes from `isOwnerDecisionAudience` (@myrmidon/shared) —
// the same predicate the part A/B filter uses, so the journal never disagrees
// with what the filter lets through:
//
//   "owner_decision" <=> effectiveResolverPolicy == "human_only"
//                       OR addresseeUserId == (issue.responsibleUserId
//                                              ?? issue.createdByUserId)
//   (an interaction addressed to an agent is never an owner decision)
//   otherwise "operational".

import { isOwnerDecisionAudience } from "@myrmidon/shared";

/** The frozen journal classification values (inter-part contract). */
export type OwnerDeliveryClassification = "owner_decision" | "operational";

export interface OwnerDeliveryClassifyInput {
  effectiveResolverPolicy: string | null | undefined;
  addresseeUserId: string | null | undefined;
  /** Set when the interaction is addressed to an agent. */
  addresseeAgentId?: string | null | undefined;
  /** The card-owning task's responsible user (null when unassigned). */
  issueResponsibleUserId: string | null | undefined;
  /** The card-owning task's creator. */
  issueCreatedByUserId: string | null | undefined;
}

export interface OwnerDeliveryClassificationResult {
  classification: OwnerDeliveryClassification;
  /** Machine-readable explanation for the journal. */
  reason: string;
}

/**
 * Classify one publication that reached an owner's DM conversation. Pure and
 * total: any combination of missing fields still yields a verdict.
 */
export function classifyOwnerDeliveryPublication(
  input: OwnerDeliveryClassifyInput,
): OwnerDeliveryClassificationResult {
  const ownerUserId =
    input.issueResponsibleUserId ?? input.issueCreatedByUserId ?? null;
  const isDecision = isOwnerDecisionAudience({
    effectiveResolverPolicy: input.effectiveResolverPolicy,
    addresseeAgentId: input.addresseeAgentId,
    addresseeUserId: input.addresseeUserId,
    ownerUserId,
  });
  if (isDecision) {
    return {
      classification: "owner_decision",
      reason:
        input.effectiveResolverPolicy === "human_only"
          ? "effective_resolver_policy_human_only"
          : "addressee_is_issue_owner",
    };
  }
  return {
    classification: "operational",
    reason:
      input.addresseeAgentId != null
        ? "addressee_is_agent"
        : input.addresseeUserId != null && input.addresseeUserId !== ownerUserId
          ? "addressee_not_issue_owner"
          : "no_owner_addressee",
  };
}
