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
    const resolved = resolveAddresslessCard({
      id: id(50), issueIdentifier: "IRR-50", kind: "request_confirmation", createdByAgentId: id(1),
      createdByUserId: null, addresseeAgentId: null, addresseeUserId: null, requestedResolverPolicy: "anyone",
      effectiveResolverPolicy: "anyone", payload: { routing: { routeType: "decision" } }, projectId: id(70), casteKey: "review",
      executionPolicy: { reviewEscalationPolicy: {
        participantRoles: ["lead", "architect", "secondary_reviewer"], fallbackQueue: "review-recovery",
        stepDelayMinutes: 30,
        projectRoles: {
          lead: { type: "agent", agentId: id(2), projectId: id(70), casteKey: "review", projectRoles: ["lead"], isJoinedMember: true },
          architect: { type: "agent", agentId: id(3), projectId: id(70), casteKey: "review", projectRoles: ["architect"], isJoinedMember: true },
          secondary_reviewer: { type: "agent", agentId: id(4), projectId: id(70), casteKey: "review", projectRoles: ["secondary_reviewer"], isJoinedMember: true },
        },
      } },
      projectRoles: {
        lead: { type: "agent", agentId: id(2), projectId: id(70), casteKey: "review", projectRoles: ["lead"], isJoinedMember: true },
        architect: { type: "agent", agentId: id(3), projectId: id(70), casteKey: "review", projectRoles: ["architect"], isJoinedMember: true },
        secondary_reviewer: { type: "agent", agentId: id(4), projectId: id(70), casteKey: "review", projectRoles: ["secondary_reviewer"], isJoinedMember: true },
      },
    });
    expect(resolved.proposedRecipient).toBe(`agent:${id(3)}`);
    expect(resolved.escalationChain).toEqual([
      { recipient: `agent:${id(3)}`, afterMinutes: 0 },
      { recipient: `agent:${id(4)}`, afterMinutes: 30 },
      { recipient: "queue:review-recovery", afterMinutes: 60 },
    ]);
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
        VALUES (${companyId}, 'Interaction readdress report test', 'IRR-REPORT-TEST')
      `);
      await db.execute(sql`
        INSERT INTO issues (id, company_id, title, identifier)
        VALUES (${issueId}, ${companyId}, 'Readdress report fixture', 'IRR-1')
      `);
      await db.execute(sql`
        INSERT INTO agents (id, company_id, name)
        VALUES (${id(1)}, ${companyId}, 'Creator'), (${id(2)}, ${companyId}, 'Existing recipient')
      `);

      await db.execute(sql`
        INSERT INTO agents (id, company_id, name)
        VALUES (${id(3)}, ${companyId}, 'Architect'), (${id(4)}, ${companyId}, 'Secondary reviewer')
      `);
      await db.execute(sql`
        INSERT INTO project_memberships (company_id, project_id, user_id, state)
        VALUES (${companyId}, ${id(9002)}, ${id(3)}, 'joined'), (${companyId}, ${id(9002)}, ${id(4)}, 'joined')
      `);

      const inserts = Array.from({ length: 10 }, (_, index) => {
        const n = index + 1;
        const policy = n <= 4 ? "human_only" : n <= 7 ? "anyone" : "not_creator";
        const addressed = n === 2 || n === 6 || n === 9;
        const payload = n === 5 ? {
          routing: {
            routeType: "decision",
            projectRoles: {
              lead: { type: "agent", agentId: id(1), projectId: id(9002), casteKey: "review", projectRoles: ["lead"], isJoinedMember: true },
              architect: { type: "agent", agentId: id(3), projectId: id(9002), casteKey: "review", projectRoles: ["architect"], isJoinedMember: true },
              secondary_reviewer: { type: "agent", agentId: id(4), projectId: id(9002), casteKey: "review", projectRoles: ["secondary_reviewer"], isJoinedMember: true },
            },
            escalationPolicy: {
              participantRoles: ["lead", "architect", "secondary_reviewer"],
              fallbackQueue: "review-recovery",
              stepDelayMinutes: 30,
            },
          },
        } : { prompt: `item-${n}` };
        return sql`(
          ${id(n)}::uuid, ${companyId}::uuid, ${issueId}::uuid, 'request_confirmation', 'pending', ${id(1)}::uuid,
          ${addressed ? id(2) : null}::uuid, ${null}::text, ${policy}, ${policy}, ${JSON.stringify(payload)}::jsonb
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
      expect(report.find((entry) => entry.id === id(5))?.proposedRecipient).toBe(`agent:${id(2)}`);
      expect(report.find((entry) => entry.id === id(5))?.escalationChain).toEqual([
        { recipient: `agent:${id(2)}`, afterMinutes: 0 },
        { recipient: `agent:${id(3)}`, afterMinutes: 30 },
        { recipient: "queue:review-recovery", afterMinutes: 60 },
      ]);
      expect(report.filter((entry) => entry.id !== id(5)).every((entry) => entry.proposedRecipient === "unresolved" && entry.reason)).toBe(true);
      expect(after).toBe(before);
    }, 90_000);
  });
});
