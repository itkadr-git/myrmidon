import { sql } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { logActivity } from "./activity-log.js";

type CycleRow = { id: string; company_id: string; parent_id: string };

/** Remove one parent edge per cycle, then persist a system activity record. */
export async function reconcileIssueParentCyclesOnStartup(db: Db) {
  const rows = await db.execute<CycleRow>(sql`
    WITH RECURSIVE walk(start_id, id, parent_id, path, cycle) AS (
      SELECT id::text, id::text, parent_id::text, ARRAY[id::text], false
      FROM issues
      WHERE parent_id IS NOT NULL
      UNION ALL
      SELECT walk.start_id, parent.id, parent.parent_id,
        walk.path || parent.id,
        parent.id = ANY(walk.path)
      FROM walk
      JOIN issues parent ON parent.id = walk.parent_id
      WHERE NOT walk.cycle AND cardinality(walk.path) <= 1000
    ), cycle_edges AS (
      SELECT DISTINCT id
      FROM walk WHERE cycle
    )
    SELECT issue.id, issue.company_id, issue.parent_id
    FROM issues issue JOIN cycle_edges cycle ON cycle.id = issue.id
  `);
  const repaired: CycleRow[] = [];
  for (const row of rows) {
    const updated = await db.execute<CycleRow>(sql`
      UPDATE issues SET parent_id = NULL
      WHERE id = ${row.id} AND parent_id = ${row.parent_id}
      RETURNING id, company_id, ${row.parent_id}::text AS parent_id
    `);
    if (updated[0]) repaired.push(updated[0]);
  }
  for (const row of repaired) {
    await logActivity(db, {
      companyId: row.company_id,
      actorType: "system",
      actorId: "issue-parent-cycle-reconciliation",
      action: "issue.parent_cycle_repaired",
      entityType: "issue",
      entityId: row.id,
      details: { previousParentId: row.parent_id },
    });
  }
  return { repaired: repaired.length };
}