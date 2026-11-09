// myrmidon(OPE-12220): the orphan-blocker reconcile (vendor) assigns a blocking
// issue that has no assignee back to the agent that created it. A lead slicing an
// epic creates engineer subtasks unassigned on purpose, so the caste matcher hands
// them to engineers; the reconcile gave them to the lead instead, and the leads
// ended up writing the code (prod 07.11: 11 subtasks on adm-dev-lead and
// adm-dev-lead-3). A creator whose role differs from the issue's caste is not
// the right owner; the issue stays unassigned for the caste matcher.

/** True when the orphan blocker may be assigned back to its creator. */
export function orphanBlockerFitsCreator(input: {
  issueCasteKey: string | null | undefined;
  creatorRole: string | null | undefined;
}): boolean {
  const caste = input.issueCasteKey?.trim();
  if (!caste) return true;
  return (input.creatorRole ?? "").trim() === caste;
}
