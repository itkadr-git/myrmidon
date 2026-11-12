// server/src/myrmidon/tool-complaints/threshold.ts
//
// myrmidon(1.7 TOOL-COMPLAINTS-UI, OPE-12229): the complaint threshold
// warning next to the tool-complaints feed.
//
// Pure core first: the grouping works on the already-read rows of the feed,
// so the route and the tests share one implementation. A complaint counts
// toward a tool's warning while it is not `resolved` — a resolved complaint
// is triage that already happened and never re-triggers the same warning.
// Every non-resolved complaint of one tool folds into ONE warning card: the
// board shows the warning when the count reaches the threshold, not one card
// per complaint.
//
// No auto-disable lives here or anywhere in this feature: the threshold only
// lights the warning on the board; disabling a tool stays the operator's
// explicit action through the agent's existing tool rights.

import type { ToolComplaint, ToolComplaintThresholdWarning } from "@myrmidon/shared";

/** Open complaints on one tool that turn the warning on. */
export const TOOL_COMPLAINT_THRESHOLD = 3;

/**
 * Group the feed into one threshold warning per tool, ordered by count then
 * name so the board's card order is stable. `resolved` complaints never
 * count; everything else (open, acknowledged) does.
 */
export function complaintThresholdWarnings(
  complaints: ToolComplaint[],
  threshold: number = TOOL_COMPLAINT_THRESHOLD,
): ToolComplaintThresholdWarning[] {
  const counts = new Map<string, number>();
  for (const complaint of complaints) {
    if (complaint.status === "resolved") continue;
    counts.set(complaint.tool, (counts.get(complaint.tool) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tool, openCount]) => ({
      tool,
      openCount,
      threshold,
      warning: openCount >= threshold,
    }))
    .sort((a, b) => (b.openCount - a.openCount) || a.tool.localeCompare(b.tool));
}
