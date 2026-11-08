// myrmidon(DB-PERF-P7): the issue list orders and reports by the denormalized
// issues.last_activity_at instead of running two correlated MAX subqueries per
// candidate row. This suite pins the migration's backfill against the exact
// expression it replaced, the write paths that have to move the column (comment,
// activity row, issue update) and the ones that must not (local-inbox actions).
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

type Sql = ReturnType<typeof postgres>;

const MIGRATION_PATH = fileURLToPath(
  new URL(
    "./migrations/0355_issues_last_activity_at.sql",
    import.meta.url,
  ),
);

// The canonical expression the service used before the column existed
// (issueCanonicalLastActivityAtExpr), written out here as the oracle.
const CANONICAL_EXPRESSION = `GREATEST(
  i."updated_at",
  COALESCE((
    SELECT MAX(c."created_at") FROM "issue_comments" c
    WHERE c."issue_id" = i."id" AND c."company_id" = i."company_id"
  ), to_timestamp(0)),
  COALESCE((
    SELECT MAX(l."created_at") FROM "activity_log" l
    WHERE l."company_id" = i."company_id"
      AND l."entity_type" = 'issue'
      AND l."entity_id" = i."id"::text
      AND l."action" NOT IN ('issue.read_marked','issue.read_unmarked','issue.inbox_archived','issue.inbox_unarchived')
  ), to_timestamp(0))
)`;

const COMPANY_ID = "00000000-0000-0000-0000-00000000c001";

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function startDatabase(prefix: string) {
  const dbh = await startEmbeddedPostgresTestDatabase(prefix);
  cleanups.push(() => dbh.cleanup());
  const sql = postgres(dbh.connectionString, { max: 1 });
  cleanups.push(async () => {
    await sql.end();
  });
  await sql`INSERT INTO companies ("id","name") VALUES (${COMPANY_ID}, 'company-a')`;
  return sql;
}

async function seedIssue(
  sql: Sql,
  id: string,
  title: string,
  updatedAt: string,
) {
  await sql`INSERT INTO issues ("id","company_id","title","created_at","updated_at")
    VALUES (${id}, ${COMPANY_ID}, ${title}, ${updatedAt}, ${updatedAt})`;
}

async function seedComment(sql: Sql, id: string, issueId: string, at: string) {
  await sql`INSERT INTO issue_comments ("id","company_id","issue_id","body","created_at")
    VALUES (${id}, ${COMPANY_ID}, ${issueId}, 'comment-a', ${at})`;
}

async function seedActivity(
  sql: Sql,
  id: string,
  issueId: string,
  action: string,
  at: string,
) {
  await sql`INSERT INTO activity_log ("id","company_id","actor_id","action","entity_type","entity_id","created_at")
    VALUES (${id}, ${COMPANY_ID}, 'actor-a', ${action}, 'issue', ${issueId}, ${at})`;
}

async function activityAt(sql: Sql, issueId: string) {
  const rows = await sql`SELECT "last_activity_at" AS "at" FROM issues WHERE "id" = ${issueId}`;
  return (rows[0].at as Date).toISOString();
}

async function compareWithCanonicalExpression(sql: Sql) {
  const rows = await sql.unsafe(
    `SELECT i."id" AS "id", i."last_activity_at" AS "at", ${CANONICAL_EXPRESSION} AS "expected"
     FROM "issues" i WHERE i."company_id" = '${COMPANY_ID}' ORDER BY i."id"`,
  );
  return rows.map((row) => ({
    id: row.id as string,
    at: (row.at as Date).toISOString(),
    expected: (row.expected as Date).toISOString(),
  }));
}

async function migrationStatementContaining(needle: string) {
  const text = await readFile(MIGRATION_PATH, "utf8");
  const statement = text
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    .find((part) => part.includes(needle));
  expect(statement, `migration statement containing ${needle}`).toBeTruthy();
  return statement as string;
}
const UPDATED_OLDER = "2026-01-01T10:00:00.000Z";
const COMMENT_AT = "2026-01-02T10:00:00.000Z";
const LOG_AT = "2026-01-03T10:00:00.000Z";
const UPDATED_NEWER = "2026-01-05T10:00:00.000Z";
const INBOX_AT = "2026-01-09T10:00:00.000Z";

d("issues.last_activity_at", () => {
  it("backfills the column with the expression the list used before it existed", async () => {
    const sql = await startDatabase("pap0355-backfill-");
    const issueWithCommentAndLog = "00000000-0000-0000-0000-00000000a001";
    const issueWithInboxOnly = "00000000-0000-0000-0000-00000000a002";
    const quietIssue = "00000000-0000-0000-0000-00000000a003";

    await seedIssue(sql, issueWithCommentAndLog, "task-a", UPDATED_OLDER);
    await seedComment(
      sql,
      "00000000-0000-0000-0000-00000000b001",
      issueWithCommentAndLog,
      COMMENT_AT,
    );
    await seedActivity(
      sql,
      "00000000-0000-0000-0000-00000000c001",
      issueWithCommentAndLog,
      "issue.updated",
      LOG_AT,
    );

    await seedIssue(sql, issueWithInboxOnly, "task-b", UPDATED_NEWER);
    await seedActivity(
      sql,
      "00000000-0000-0000-0000-00000000c002",
      issueWithInboxOnly,
      "issue.inbox_archived",
      INBOX_AT,
    );
    await seedActivity(
      sql,
      "00000000-0000-0000-0000-00000000c003",
      issueWithInboxOnly,
      "issue.read_marked",
      INBOX_AT,
    );

    await seedIssue(sql, quietIssue, "task-c", UPDATED_OLDER);

    // Stale values of the shape a pre-migration image leaves behind: the backfill
    // has to repair them, not just fill the column once.
    await sql`UPDATE issues SET "last_activity_at" = to_timestamp(0)`;
    await sql.unsafe(
      await migrationStatementContaining(
        'UPDATE "issues" SET "last_activity_at" = GREATEST(',
      ),
    );

    const rows = await compareWithCanonicalExpression(sql);
    expect(rows.map((row) => row.id)).toEqual([
      issueWithCommentAndLog,
      issueWithInboxOnly,
      quietIssue,
    ]);
    for (const row of rows) expect(row.at).toBe(row.expected);
    expect(rows[0].at).toBe(LOG_AT);
    expect(rows[1].at).toBe(UPDATED_NEWER);
    expect(rows[2].at).toBe(UPDATED_OLDER);
  }, 90_000);

  it("raises the column on a new comment and never lowers it", async () => {
    const sql = await startDatabase("pap0355-comment-");
    const issueId = "00000000-0000-0000-0000-00000000a011";
    const laterCommentAt = "2026-02-02T10:00:00.000Z";
    await seedIssue(sql, issueId, "task-a", "2026-02-01T10:00:00.000Z");
    expect(await activityAt(sql, issueId)).toBe("2026-02-01T10:00:00.000Z");

    await seedComment(
      sql,
      "00000000-0000-0000-0000-00000000b011",
      issueId,
      laterCommentAt,
    );
    expect(await activityAt(sql, issueId)).toBe(laterCommentAt);

    const [issue] = await sql`SELECT "updated_at" FROM issues WHERE "id" = ${issueId}`;
    expect((issue.updated_at as Date).toISOString()).toBe(
      "2026-02-01T10:00:00.000Z",
    );

    await seedComment(
      sql,
      "00000000-0000-0000-0000-00000000b012",
      issueId,
      "2026-01-15T10:00:00.000Z",
    );
    expect(await activityAt(sql, issueId)).toBe(laterCommentAt);
  }, 90_000);

  it("raises the column on an activity row but not on local-inbox actions", async () => {
    const sql = await startDatabase("pap0355-log-");
    const issueId = "00000000-0000-0000-0000-00000000a021";
    const logAt = "2026-03-02T10:00:00.000Z";
    const inboxAt = "2026-03-03T10:00:00.000Z";
    await seedIssue(sql, issueId, "task-a", "2026-03-01T10:00:00.000Z");

    await seedActivity(
      sql,
      "00000000-0000-0000-0000-00000000c021",
      issueId,
      "issue.commented",
      logAt,
    );
    expect(await activityAt(sql, issueId)).toBe(logAt);

    const excluded = [
      "issue.read_marked",
      "issue.read_unmarked",
      "issue.inbox_archived",
      "issue.inbox_unarchived",
    ];
    for (const [index, action] of excluded.entries()) {
      await seedActivity(
        sql,
        `00000000-0000-0000-0000-00000000d0${index}1`,
        issueId,
        action,
        inboxAt,
      );
      expect(await activityAt(sql, issueId)).toBe(logAt);
    }

    // A row about another kind of entity that happens to carry the issue id must
    // not move the column either.
    await sql`INSERT INTO activity_log ("id","company_id","actor_id","action","entity_type","entity_id","created_at")
      VALUES ('00000000-0000-0000-0000-00000000d099', ${COMPANY_ID}, 'actor-a', 'agent.updated', 'agent', ${issueId}, ${inboxAt})`;
    expect(await activityAt(sql, issueId)).toBe(logAt);

    const rows = await compareWithCanonicalExpression(sql);
    expect(rows[0].at).toBe(logAt);
    expect(rows[0].at).toBe(rows[0].expected);
  }, 90_000);

  it("raises the column when an issue update moves updated_at", async () => {
    const sql = await startDatabase("pap0355-update-");
    const issueId = "00000000-0000-0000-0000-00000000a031";
    const laterUpdate = "2026-04-04T10:00:00.000Z";
    await seedIssue(sql, issueId, "task-a", "2026-04-01T10:00:00.000Z");

    await sql`UPDATE issues SET "title" = 'task-a renamed' WHERE "id" = ${issueId}`;
    expect(await activityAt(sql, issueId)).toBe("2026-04-01T10:00:00.000Z");

    await sql`UPDATE issues SET "status" = 'in_progress', "updated_at" = ${laterUpdate} WHERE "id" = ${issueId}`;
    expect(await activityAt(sql, issueId)).toBe(laterUpdate);
    const [issue] = await sql`SELECT "status" FROM issues WHERE "id" = ${issueId}`;
    expect(issue.status).toBe("in_progress");
  }, 90_000);

  it("sorts the list from the new index without correlated subplans", async () => {
    const sql = await startDatabase("pap0355-plan-");
    await sql.unsafe(
      `INSERT INTO issues ("company_id","title","created_at","updated_at")
       SELECT '${COMPANY_ID}', 'task-' || series,
         now() - (series || ' minutes')::interval,
         now() - (series || ' minutes')::interval
       FROM generate_series(1, 200) AS series`,
    );

    await sql.unsafe("SET enable_seqscan = off");
    const planRows = await sql.unsafe(
      `EXPLAIN SELECT "id" FROM "issues" WHERE "company_id" = '${COMPANY_ID}'
       ORDER BY "last_activity_at" DESC LIMIT 50`,
    );
    const planText = planRows
      .map((row) => Object.values(row)[0] as string)
      .join("\n");
    expect(planText).toContain("issues_company_last_activity_at_idx");
    expect(planText).not.toContain("SubPlan");
    expect(planText).not.toContain("issue_comments");
    console.log(`[DB-PERF-P7] issue list plan (after):\n${planText}`);

    // The shape the endpoint used before the column: same order, but the plan
    // carries the correlated subplans that this change removes.
    const legacyPlanRows = await sql.unsafe(
      `EXPLAIN SELECT i."id" FROM "issues" i WHERE i."company_id" = '${COMPANY_ID}'
       ORDER BY ${CANONICAL_EXPRESSION} DESC LIMIT 50`,
    );
    const legacyPlanText = legacyPlanRows
      .map((row) => Object.values(row)[0] as string)
      .join("\n");
    expect(legacyPlanText).toContain("SubPlan");
    console.log(`[DB-PERF-P7] issue list plan (before):\n${legacyPlanText}`);
  }, 90_000);

  it("keeps the list order identical to the expression it replaced", async () => {
    const sql = await startDatabase("pap0355-order-");
    const base = Date.parse("2026-05-01T10:00:00.000Z");
    const ids: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const id = `00000000-0000-0000-0000-00000000e0${index}${index}`;
      ids.push(id);
      await seedIssue(
        sql,
        id,
        `task-${index}`,
        new Date(base + index * 60_000).toISOString(),
      );
    }
    await seedComment(
      sql,
      "00000000-0000-0000-0000-00000000f001",
      ids[1],
      new Date(base + 30 * 60_000).toISOString(),
    );
    await seedActivity(
      sql,
      "00000000-0000-0000-0000-00000000f002",
      ids[2],
      "issue.updated",
      new Date(base + 10 * 60_000).toISOString(),
    );
    await seedActivity(
      sql,
      "00000000-0000-0000-0000-00000000f003",
      ids[3],
      "issue.inbox_archived",
      new Date(base + 90 * 60_000).toISOString(),
    );
    await seedComment(
      sql,
      "00000000-0000-0000-0000-00000000f004",
      ids[4],
      new Date(base + 30_000).toISOString(),
    );

    const byColumn = await sql.unsafe(
      `SELECT "id" FROM "issues" WHERE "company_id" = '${COMPANY_ID}'
       ORDER BY "last_activity_at" DESC, "updated_at" DESC, "id" DESC`,
    );
    const byExpression = await sql.unsafe(
      `SELECT i."id" FROM "issues" i WHERE i."company_id" = '${COMPANY_ID}'
       ORDER BY ${CANONICAL_EXPRESSION} DESC, i."updated_at" DESC, i."id" DESC`,
    );
    const columnOrder = byColumn.map((row) => row.id as string);
    expect(columnOrder).toHaveLength(6);
    expect(columnOrder).toEqual(byExpression.map((row) => row.id as string));
    expect(columnOrder).toEqual([
      ids[1],
      ids[2],
      ids[5],
      ids[4],
      ids[3],
      ids[0],
    ]);

    const rows = await compareWithCanonicalExpression(sql);
    for (const row of rows) expect(row.at).toBe(row.expected);
  }, 90_000);
});
