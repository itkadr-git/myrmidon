import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";
import { formatReport, loadReport, resolveAddresslessCard } from "./readdress-report.js";
import { sql } from "drizzle-orm";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const support = await getEmbeddedPostgresTestSupport();
const describeEmbedded = support.supported ? describe : describe.skip;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("interaction readdress report", () => {
  it("resolves policy, serializes output, and reports ten PG fixtures without writes", async () => {
    expect(resolveAddresslessCard({ effectiveResolverPolicy: "anyone" }).proposedRecipient).toBe("unresolved");
    expect(resolveAddresslessCard({ effectiveResolverPolicy: "not_creator" }).proposedRecipient).toBe("unresolved");
    expect(resolveAddresslessCard({ effectiveResolverPolicy: "human_only" }).proposedRecipient).toBe("unresolved");
    const addressed = resolveAddresslessCard({ addresseeAgentId: id(2), addresseeUserId: null });
    expect(addressed.proposedRecipient).toBe(id(2));
    const row = { ...addressed, issueIdentifier: 'OPE,"1' };
    expect(JSON.parse(formatReport([row], "json"))).toEqual([row]);
    expect(formatReport([row], "csv")).toContain('"OPE,""1"');
  });

  describeEmbedded("PostgreSQL read-only integration", () => {
    it("returns seven addressless cards from ten and preserves their table hash", async () => {
      const database = await startEmbeddedPostgresTestDatabase("interaction-readdress-report-");
      cleanups.push(() => database.cleanup());
      const db = createDb(database.connectionString);
      cleanups.push(() => db.$client.end());

      await db.execute(sql.raw(`
        CREATE TABLE issues (id uuid PRIMARY KEY, company_id uuid NOT NULL, identifier text);
        CREATE TABLE issue_thread_interactions (
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
      expect(report).toHaveLength(7);
      expect(report.every((entry) => entry.proposedRecipient === "unresolved" && entry.reason)).toBe(true);
      expect(after).toBe(before);
    }, 90_000);
  });
});
