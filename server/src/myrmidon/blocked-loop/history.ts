// myrmidon(BLOCKED-LOOP): reads the task's recent status events from the
// activity log and shapes them for the pure policy.

import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog } from "@paperclipai/db";
import type { BlockedLoopEvent } from "./policy.js";

/** Key under `issue.updated` details where the guard records its signature. */
export const BLOCKED_LOOP_SIGNATURE_KEY = "blockedLoop";

export interface BlockedLoopSignature {
  blockerSetKey: string;
  descriptorKey: string | null;
}

const SETTLED_STATUSES: ReadonlySet<string> = new Set(["done", "cancelled", "in_review"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Maps one `issue.updated` activity row to a policy event; null when it is not a status move. */
export function toBlockedLoopEvent(row: {
  createdAt: Date;
  actorType: string;
  details: unknown;
}): BlockedLoopEvent | null {
  const details = asRecord(row.details);
  const status = asRecord(asRecord(details?.changes)?.status);
  if (!details || !status) return null;
  const to = typeof status.to === "string" ? status.to : null;
  const from = typeof status.from === "string" ? status.from : null;
  if (to === "blocked" && from !== "blocked") {
    const signature = asRecord(details[BLOCKED_LOOP_SIGNATURE_KEY]);
    return {
      createdAt: row.createdAt,
      actorType: row.actorType,
      kind: "entered_blocked",
      blockerSetKey: typeof signature?.blockerSetKey === "string" ? signature.blockerSetKey : null,
      descriptorKey: typeof signature?.descriptorKey === "string" ? signature.descriptorKey : null,
    };
  }
  if (from === "blocked" && to !== null && to !== "blocked") {
    return {
      createdAt: row.createdAt,
      actorType: row.actorType,
      kind: SETTLED_STATUSES.has(to) ? "settled" : "left_blocked",
      blockerSetKey: null,
      descriptorKey: null,
    };
  }
  return null;
}

/** Newest status events of one task (enough rows for `2 * maxReturns` cycles). */
export async function loadBlockedLoopEvents(
  db: Db,
  input: { companyId: string; issueId: string; maxReturns: number },
): Promise<BlockedLoopEvent[]> {
  const rows = await db
    .select({
      createdAt: activityLog.createdAt,
      actorType: activityLog.actorType,
      details: activityLog.details,
    })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, input.companyId),
        eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, input.issueId),
        eq(activityLog.action, "issue.updated"),
        sql`(${activityLog.details} -> 'changes' -> 'status') is not null`,
      ),
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(input.maxReturns * 2 + 6);
  return rows.flatMap((row) => {
    const event = toBlockedLoopEvent(row);
    return event ? [event] : [];
  });
}
