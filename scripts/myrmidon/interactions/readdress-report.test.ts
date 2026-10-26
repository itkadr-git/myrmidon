import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "@myrmidon/db";
import { sql } from "drizzle-orm";
import { formatReport, loadReport, resolveAddresslessCard, type PendingCard } from "./readdress-report.js";

const embeddedSupport = await getEmbeddedPostgresTestSupport();
const describePostgres = embeddedSupport.supported ? describe : describe.skip;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

const baseCard = (overrides: Partial<PendingCard> = {}): PendingCard => ({
  id: "interaction-1",
  issueIdentifier: "OPE-1",
  kind: "request_confirmation",
  createdByAgentId: "00000000-0000-4000-8000-000000000001",
  addresseeAgentId: null,
  addresseeUserId: null,
  requestedResolverPolicy: "anyone",
  effectiveResolverPolicy: "anyone",
  payload: { version: 1 },
  ...overrides,
});

describe("interaction readdress report policy", () => {
  it("marks audience-only policies and human-only cards unresolved and preserves named recipients", () => {
    expect(resolveAddresslessCard(baseCard()).proposedRecipient).toBe("unresolved");
    expect(resolveAddresslessCard(baseCard({ effectiveResolverPolicy: "not_creator" })).proposedRecipient).toBe("unresolved");
    expect(resolveAddresslessCard(baseCard({ effectiveResolverPolicy: "human_only" })).proposedRecipient).toBe("unresolved");
    expect(resolveAddresslessCard(baseCard({ addresseeAgentId: "agent-2" })).proposedRecipient).toBe("agent-2");
    expect(resolveAddresslessCard(baseCard({ addresseeUserId: "user-2" })).proposedRecipient).toBe("user:user-2");
  });

  it("serializes JSON and escaped CSV", () => {
    const row = resolveAddresslessCard(baseCard({ issueIdentifier: 'OPE,"1' }));
    expect(JSON.parse(formatReport([row], "json"))).toEqual([row]);
    expect(formatReport([row], "csv")).toContain('"OPE,""1"');
  });
});

describePostgres("interaction readdress report read-only PostgreSQL integration", () => {
  it("reports ten fixture cards without changing any database rows", async () => {
    const database = await startEmbeddedPostgresTestDatabase("interaction-readdress-report-");
    cleanups.push(database.cleanup);
    const db = createDb(database.connectionString);
    try {
      await db.execute(sql.raw(`
        CREATE TEMP TABLE companies (id uuid PRIMARY KEY, name text NOT NULL);
        CREATE TEMP TABLE agents (id uuid PRIMARY KEY, company_id uuid NOT NULL, name text NOT NULL);
        CREATE TEMP TABLE issues (id uuid PRIMARY KEY, company_id uuid NOT NULL, identifier text);
        CREATE TEMP TABLE issue_thread_interactions (
          id uuid PRIMARY KEY, company_id uuid NOT NULL, issue_id uuid NOT NULL,
          kind text NOT NULL, status text NOT NULL, created_by_agent_id uuid,
          addressee_agent_id uuid, addressee_user_id text,
          requested_resolver_policy text NOT NULL, effective_resolver_policy text NOT NULL,
          payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
        );
        INSERT INTO companies VALUES ('00000000-0000-4000-8000-000000000001', 'test');
        INSERT INTO agents VALUES
          ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'creator'),
          ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'recipient');
        INSERT INTO issues VALUES ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'OPE-TEST');
      `));
      for (let i = 1; i <= 10; i += 1) {
        const policy = i <= 4 ? "human_only" : i <= 7 ? "anyone" : "not_creator";
        const addressed = i === 2 || i === 6 || i === 9;
        await db.execute(sql`
          INSERT INTO issue_thread_interactions (
            id, company_id, issue_id, kind, status, created_by_agent_id,
            addressee_agent_id, requested_resolver_policy, effective_resolver_policy, payload
          ) VALUES (
            ${`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`}::uuid,
            '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
            'request_confirmation', 'pending', '00000000-0000-4000-8000-000000000001',
            ${addressed ? "00000000-0000-4000-8000-000000000002" : null}::uuid,
            ${policy}, ${policy}, ${JSON.stringify({ prompt: `item-${i}` })}::jsonb
          )
        `);
      }
      const fingerprint = async () => {
        const rows = await db.execute(sql`SELECT * FROM issue_thread_interactions ORDER BY id`);
        return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
      };
      const before = await fingerprint();
      const report = await loadReport(database.connectionString);
      const after = await fingerprint();
      expect(report).toHaveLength(7);
      expect(report.filter((row) => row.proposedRecipient === "unresolved")).toHaveLength(7);
      expect(report.every((row) => typeof row.reason === "string" && row.reason.length > 0)).toBe(true);
      expect(after).toBe(before);
    } finally {
      await db.$client.end();
    }
  }, 90_000);
});
