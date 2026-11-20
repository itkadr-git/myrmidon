import { and, eq, isNull, notInArray } from "drizzle-orm";
import { activityLog, issues } from "@myrmidon/db";
import { unprocessable } from "../../errors.js";
import { AUTO_SLICE_TITLE } from "./auto-slice-policy.js";

export const AUTO_SLICE_CHILD_NEEDS_RELEASE_LABEL = "auto_slice_child_needs_release_label";

const RELEASE_LABEL = /^\d+\.\d+(\.\d+)?$/;

export function isAutoSliceTitle(title: string | null | undefined): boolean {
  return title === AUTO_SLICE_TITLE;
}

/** A task cut under an AUTO-SLICE task must carry a release label; otherwise 422. */
export function assertAutoSliceChildHasReleaseLabel(input: {
  parentTitle: string | null | undefined;
  labelNames: readonly string[];
}): void {
  if (!isAutoSliceTitle(input.parentTitle)) return;
  if (input.labelNames.some((name) => RELEASE_LABEL.test(name.trim()))) return;
  throw unprocessable(
    "Задача нарезки без метки выпуска не создаётся: добавьте метку выпуска (например 1.6.9) в labelIds.",
    { code: AUTO_SLICE_CHILD_NEEDS_RELEASE_LABEL },
  );
}

export type AutoSliceChildrenPlan =
  | { kind: "move"; epicIdentifier: string }
  | { kind: "leave"; reason: "no_epics" | "several_epics"; epicIdentifiers: string[] };

/** Reads the `Открытые эпики:` list of an AUTO-SLICE description. */
export function planAutoSliceChildren(description: string | null | undefined): AutoSliceChildrenPlan {
  const text = description ?? "";
  const at = text.indexOf("Открытые эпики:");
  const section = at < 0 ? "" : text.slice(at);
  const ids = [...new Set([...section.matchAll(/\(\/issues\/([A-Za-z0-9]+-\d+)\)/g)].map((match) => match[1]!))];
  if (ids.length === 1) return { kind: "move", epicIdentifier: ids[0]! };
  return { kind: "leave", reason: ids.length === 0 ? "no_epics" : "several_epics", epicIdentifiers: ids };
}

/**
 * When an AUTO-SLICE task is closed as done, its open children go to the epic named in
 * its description. With zero or several epics they stay and the reason is written to activity.
 */
export async function moveAutoSliceChildrenToEpic(
  tx: any,
  slice: { id: string; companyId: string; title: string; description: string | null; projectId?: string | null },
): Promise<void> {
  if (!isAutoSliceTitle(slice.title)) return;
  const children: Array<{ id: string }> = await tx
    .select({ id: issues.id })
    .from(issues)
    .where(and(
      eq(issues.companyId, slice.companyId), eq(issues.parentId, slice.id), isNull(issues.hiddenAt),
      notInArray(issues.status, ["done", "cancelled"]),
    ));
  if (children.length === 0) return;
  const plan = planAutoSliceChildren(slice.description);
  let details: Record<string, unknown> = { sliceIssueId: slice.id, childCount: children.length };
  let action = "issue.auto_slice_children_left";
  if (plan.kind === "move") {
    const [epic] = await tx
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, slice.companyId), eq(issues.identifier, plan.epicIdentifier)))
      .limit(1);
    if (epic) {
      await tx.update(issues).set({ parentId: epic.id, updatedAt: new Date() }).where(and(
        eq(issues.companyId, slice.companyId), eq(issues.parentId, slice.id), isNull(issues.hiddenAt),
        notInArray(issues.status, ["done", "cancelled"]),
      ));
      action = "issue.auto_slice_children_moved";
      details = { ...details, epicIdentifier: plan.epicIdentifier, epicId: epic.id };
    } else {
      details = { ...details, reason: "epic_not_found", epicIdentifier: plan.epicIdentifier };
    }
  } else {
    details = { ...details, reason: plan.reason, epicIdentifiers: plan.epicIdentifiers };
  }
  await tx.insert(activityLog).values({
    companyId: slice.companyId, actorType: "system", actorId: "auto-slice",
    action, entityType: "issue", entityId: slice.id, details,
  });
}
