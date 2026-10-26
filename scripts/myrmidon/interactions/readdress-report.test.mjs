import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createDb, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "@myrmidon/db";
import { sql } from "drizzle-orm";
import { formatReport, loadReport, resolveAddresslessCard } from "./readdress-report.ts";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const embeddedSupport = await getEmbeddedPostgresTestSupport();

test("interaction readdress report resolves policy, serializes output, and only reads", async (t) => {
  assert.equal(resolveAddresslessCard({ effectiveResolverPolicy: "anyone" }).proposedRecipient, "unresolved");
  assert.equal(resolveAddresslessCard({ effectiveResolverPolicy: "not_creator" }).proposedRecipient, "unresolved");
  assert.equal(resolveAddresslessCard({ effectiveResolverPolicy: "human_only" }).proposedRecipient, "unresolved");
  const addressed = resolveAddresslessCard({ addresseeAgentId: id(2), addresseeUserId: null });
  assert.equal(addressed.proposedRecipient, id(2));
  const row = { ...addressed, issueIdentifier: 'OPE,"1' };
  assert.deepEqual(JSON.parse(formatReport([row], "json")), [row]);
  assert.match(formatReport([row], "csv"), /"OPE,""1"/);

  if (!embeddedSupport.supported) {
    t.skip(`embedded PostgreSQL unavailable: ${embeddedSupport.reason ?? "unsupported platform"}`);
    return;
  }

  const database = await startEmbeddedPostgresTestDatabase("interaction-readdress-report-");
  t.after(database.cleanup);
  const db = createDb(database.connectionString);
  t.after(() => db.$client.end());

  await db.execute(sql.raw(`
    CREATE TEMP TABLE issues (id uuid PRIMARY KEY, company_id uuid NOT NULL, identifier text);
    CREATE TEMP TABLE issue_thread_interactions (
      id uuid PRIMARY KEY, company_id uuid NOT NULL, issue_id uuid NOT NULL,
      kind text NOT NULL, status text NOT NULL, created_by_agent_id uuid,
      addressee_agent_id uuid, addressee_user_id text,
      requested_resolver_policy text NOT NULL, effective_resolver_policy text NOT NULL,
      payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO issues VALUES ('${id(1)}', '${id(1)}', 'OPE-TEST');
  `));
  const inserts = Array.from({ length: 10 }, (_, index) => {
    const n = index + 1;
    const policy = n <= 4 ? "human_only" : n <= 7 ? "anyone" : "not_creator";
    const addressed = n === 2 || n === 6 || n === 9;
    return sql`(
      ${id(n)}::uuid, ${id(1)}::uuid, ${id(1)}::uuid, 'request_confirmation', 'pending', ${id(1)}::uuid,
      ${addressed ? id(2) : null}::uuid, ${null}::text, ${policy}, ${policy}, ${JSON.stringify({ prompt: `item-${n}` })}::jsonb
    )`;
  });
  await db.execute(sql`
    INSERT INTO issue_thread_interactions (
      id, company_id, issue_id, kind, status, created_by_agent_id, addressee_agent_id,
      addressee_user_id, requested_resolver_policy, effective_resolver_policy, payload
    ) VALUES ${sql.join(inserts, sql`, `)}
  `);

  const fingerprint = async () => {
    const rows = await db.execute(sql`SELECT * FROM issue_thread_interactions ORDER BY id`);
    return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  };
  const before = await fingerprint();
  const report = await loadReport(database.connectionString);
  const after = await fingerprint();
  assert.equal(report.length, 7);
  assert.equal(report.filter((entry) => entry.proposedRecipient === "unresolved").length, 7);
  assert.ok(report.every((entry) => typeof entry.reason === "string" && entry.reason.length > 0));
  assert.equal(after, before, "the read-only report changed interaction rows");
});
