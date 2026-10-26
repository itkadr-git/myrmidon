import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import { startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";
import { formatReport, loadReport, resolveAddresslessCard } from "./readdress-report.js";
import { sql } from "drizzle-orm";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
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

  describe("PostgreSQL read-only integration", () => {
    it("returns seven addressless cards from ten and preserves their table hash", async () => {
      const database = await startEmbeddedPostgresTestDatabase("interaction-readdress-report-");
      cleanups.push(() => database.cleanup());
      const db = createDb(database.connectionString);
      cleanups.push(() => db.$client.end());

      const companyId = id(9001);
      const issueId = id(9002);
      await db.execute(sql`
        INSERT INTO companies (id, name, issue_prefix)
        VALUES (${companyId}, 'Interaction readdress report test', ${`IRR${9001}`})
      `);
      await db.execute(sql`
        INSERT INTO issues (id, company_id, title, identifier)
        VALUES (${issueId}, ${companyId}, 'Readdress report fixture', 'IRR-1')
      `);
      await db.execute(sql`
        INSERT INTO agents (id, company_id, name)
        VALUES (${id(1)}, ${companyId}, 'Creator'), (${id(2)}, ${companyId}, 'Existing recipient')
      `);

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
      expect(report.map((entry) => entry.id)).toEqual([id(1), id(3), id(4), id(5), id(7), id(8), id(10)]);
      expect(report.map((entry) => entry.effectiveResolverPolicy)).toEqual([
        "human_only", "human_only", "human_only", "anyone", "anyone", "not_creator", "not_creator",
      ]);
      expect(report.every((entry) => entry.proposedRecipient === "unresolved" && entry.reason)).toBe(true);
      expect(after).toBe(before);
    }, 90_000);
  });
});
