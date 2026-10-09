// myrmidon(1.6.5-OWNER-DM-FILTER): shared classification of owner-DM chat
// publications. Part C (delivery journal) uses it to label each journal entry;
// part A (the enqueue filter) may reuse it after its rebase — until then a
// copy of this logic lives in part A. The classification contract is frozen
// between the parts:
//
//   "owner_decision" <=> effectiveResolverPolicy == "human_only"
//                       OR addresseeUserId == (issue.responsibleUserId
//                                              ?? issue.createdByUserId)
//   otherwise "operational".
//
// The owner is the task's responsible user, falling back to its creator — the
// same definition telegramOwnerDeliveryBindings uses to pick the DM.

/** The frozen journal classification values (inter-part contract). */
export type OwnerDeliveryClassification = "owner_decision" | "operational";

export interface OwnerDeliveryClassifyInput {
  effectiveResolverPolicy: string | null | undefined;
  addresseeUserId: string | null | undefined;
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
  if (input.effectiveResolverPolicy === "human_only") {
    return {
      classification: "owner_decision",
      reason: "effective_resolver_policy_human_only",
    };
  }
  if (
    ownerUserId !== null &&
    input.addresseeUserId != null &&
    input.addresseeUserId === ownerUserId
  ) {
    return {
      classification: "owner_decision",
      reason: "addressee_is_issue_owner",
    };
  }
  return {
    classification: "operational",
    reason:
      input.addresseeUserId != null && input.addresseeUserId !== ownerUserId
        ? "addressee_not_issue_owner"
        : "no_owner_addressee",
  };
}
