import { sql } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { logActivity } from "./activity-log.js";

type CycleRow = { id: string; company_id: string; parent_id: string };

/** Remove one parent edge per cycle, then persist a system activity record. */
export async function reconcileIssueParentCyclesOnStartup(db: Db) {
  const repaired = await db.execute<CycleRow>(sql`
    WITH RECURSIVE walk(start_id, id, parent_id, path, cycle) AS (
      SELECT id::text, id::text, parent_id::text, ARRAY[id::text], false
      FROM issues
      WHERE parent_id IS NOT NULL
      UNION ALL
      SELECT walk.start_id, parent.id::text, parent.parent_id::text,
        walk.path || parent.id::text,
        parent.id::text = ANY(walk.path)
      FROM walk
      JOIN issues parent ON parent.id::text = walk.parent_id
      WHERE NOT walk.cycle
    ), cycle_edges AS (
   SELECT DISTINCT ON (id) id, parent_id
   FROM walk WHERE cycle
   ORDER BY id, start_id
 )
 UPDATE issues AS issue SET parent_id = NULL
 FROM cycle_edges AS cycle
 WHERE issue.id::text = cycle.id
 RETURNING issue.id::text AS id, issue.company_id::text AS company_id,
   cycle.parent_id::text AS parent_id
  `);
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