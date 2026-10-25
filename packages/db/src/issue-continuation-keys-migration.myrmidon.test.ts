import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const file = "0419_issue_continuation_keys.sql";
const migration = await readFile(new URL(`./migrations/${file}`, import.meta.url), "utf8");
const hash = createHash("sha256").update(migration).digest("hex");
const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe("issue continuation keys migration", () => {
  it("registers the schema and migration snapshot", async () => {
    const journal = JSON.parse(await readFile(new URL("./migrations/meta/_journal.json", import.meta.url), "utf8"));
    expect(journal.entries.at(-1)).toMatchObject({ idx: 419, tag: "0419_issue_continuation_keys" });
    const snapshot = JSON.parse(await readFile(new URL("./migrations/meta/0419_snapshot.json", import.meta.url), "utf8"));
    expect(snapshot.tables["public.issue_continuation_keys"].indexes.issue_continuation_keys_company_key_uq.isUnique).toBe(true);
    expect(snapshot.tables["public.issue_continuation_keys"].foreignKeys.issue_continuation_keys_issue_id_issues_id_fk.onDelete).toBe("cascade");
  });

  it.skipIf(!support.supported)("applies twice, rejects duplicate keys and cascades with its issue", async () => {
    const database = await startEmbeddedPostgresTestDatabase("issue-continuation-keys-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(() => sql.end());
    const companyId = randomUUID();
    const issueId = randomUUID();
    await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Continuation keys', 'ICK')`;
    await sql`INSERT INTO issues (id, company_id, title, status) VALUES (${issueId}, ${companyId}, 'key owner', 'todo')`;
    // The embedded test database has already applied 0419; rewind it before
    // exercising this migration directly, including its idempotent second run.
    await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`;
    await sql`DROP TABLE IF EXISTS issue_continuation_keys`;
    const statements = migration.split("--> statement-breakpoint").filter((s) => s.trim());
    await sql.begin(async (tx) => { for (const statement of statements) await tx.unsafe(statement); });
    await sql.begin(async (tx) => { for (const statement of statements) await tx.unsafe(statement); });
    await sql`INSERT INTO issue_continuation_keys (company_id, key, issue_id, expires_at) VALUES (${companyId}, 'same-key', ${issueId}, now() + interval '1 day')`;
    await expect(sql`INSERT INTO issue_continuation_keys (company_id, key, issue_id, expires_at) VALUES (${companyId}, 'same-key', ${issueId}, now() + interval '1 day')`)
      .rejects.toMatchObject({ code: "23505", constraint_name: "issue_continuation_keys_company_key_uq" });
    await sql`DELETE FROM issues WHERE id = ${issueId}`;
    expect(await sql`SELECT * FROM issue_continuation_keys WHERE issue_id = ${issueId}`).toHaveLength(0);
  }, 30_000);
});
