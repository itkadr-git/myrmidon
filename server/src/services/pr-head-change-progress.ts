// myrmidon(EMPTY-RUNS-1): the read side of the PR head-change rows (see
// PR_HEAD_CHANGE_ACTIVITY_ACTION in issue-rewake-throttle.ts).
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { activityLog } from "@myrmidon/db";
import {
  collectRunIdsWithPrHeadChange,
  PR_HEAD_CHANGE_ACTIVITY_ACTION,
  type RunSpan,
} from "./issue-rewake-throttle.js";

/** The most head-change rows one read looks at (the newest ones inside the runs' window). */
export const PR_HEAD_CHANGE_ROW_LIMIT = 200;

/**
 * The runs among `runs` that moved the head of the task's pull request: the
 * head-change rows of the task (any actor) are read once, from the start of the
 * earliest run, and matched to each run's window by `collectRunIdsWithPrHeadChange`.
 */
export async function readRunIdsWithPrHeadChange(
  db: Pick<Db, "select">,
  companyId: string,
  issueId: string,
  runs: readonly RunSpan[],
): Promise<Set<string>> {
  const starts = runs
    .map((run) => (run.startedAt ?? run.createdAt)?.getTime())
    .filter((at): at is number => typeof at === "number");
  if (starts.length === 0) return new Set();
  const rows = await db
    .select({ at: activityLog.createdAt })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, issueId),
        eq(activityLog.action, PR_HEAD_CHANGE_ACTIVITY_ACTION),
        sql`${activityLog.details} ->> 'headShaChanged' = 'true'`,
        gte(activityLog.createdAt, new Date(Math.min(...starts))),
      ),
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(PR_HEAD_CHANGE_ROW_LIMIT);
  return collectRunIdsWithPrHeadChange(runs, rows.map((row) => row.at));
}
