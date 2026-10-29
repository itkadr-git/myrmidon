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
      id: id(50),
      issueIdentifier: "IRR-50",
      kind: "request_confirmation",
      createdByAgentId: id(1),
      createdByUserId: null,
      addresseeAgentId: null,
      addresseeUserId: null,
      requestedResolverPolicy: "anyone",
      effectiveResolverPolicy: "anyone",
      payload: {
        routing: {
          routeType: "decision",
          recipient: { type: "agent", agentId: id(3) },
          projectRoles: {
            architect: { type: "agent", agentId: id(3), projectId: id(70), casteKey: "review", projectRoles: ["architect"] },
            secondary_reviewer: { type: "agent", agentId: id(4), projectId: id(70), casteKey: "review", projectRoles: ["secondary_reviewer"] },
          },
          escalationPolicy: { participantRoles: ["architect", "secondary_reviewer"], fallbackQueue: "review-recovery", stepDelayMinutes: 30 },
        },
      },
      projectId: id(70),
      casteKey: "review",
      projectMemberships: { [id(3)]: true, [id(4)]: true },
    });
    expect(resolved.proposedRecipient).toBe(`agent:${id(3)}`);
    expect(resolved.escalationChain).toEqual([
      { recipient: `agent:${id(3)}`, afterMinutes: 0 },
      { recipient: `agent:${id(4)}`, afterMinutes: 30 },
      { recipient: "queue:review-recovery", afterMinutes: 60 },
    ]);

    // Reviewer note fix: existing addresseeAgentId must have agent: prefix
    const addressed = resolveAddresslessCard({
      addresseeAgentId: id(2),
      addresseeUserId: null,
      effectiveResolverPolicy: "anyone",
      kind: "request_confirmation",
      createdByAgentId: id(1),
      createdByUserId: null,
    });
    expect(addressed.proposedRecipient).toBe(`agent:${id(2)}`);

    // Point 2 & 3: lead in projectMemberships AND lead ONLY in projects.lead_agent_id
    const leadInMemberships = resolveAddresslessCard({
      id: id(51),
      issueIdentifier: "IRR-51",
      kind: "request_confirmation",
      createdByAgentId: id(1),
      createdByUserId: null,
      addresseeAgentId: null,
      addresseeUserId: null,
      effectiveResolverPolicy: "lead",
      projectLeadAgentId: id(10),
      projectMemberships: { [id(10)]: true },
      projectId: id(70),
    });
    expect(leadInMemberships.proposedRecipient).toBe(`agent:${id(10)}`);

    const leadOnlyInLeadAgentId = resolveAddresslessCard({
      id: id(52),
      issueIdentifier: "IRR-52",
      kind: "request_confirmation",
      createdByAgentId: id(1),
      createdByUserId: null,
      addresseeAgentId: null,
      addresseeUserId: null,
      effectiveResolverPolicy: "lead",
      projectLeadAgentId: id(11),
      projectMemberships: {}, // NOT in project_memberships!
      projectId: id(70),
    });
    expect(leadOnlyInLeadAgentId.proposedRecipient).toBe(`agent:${id(11)}`);

    // Point 1: csvValue: null/undefined/empty must produce empty cells, not literal '""'
    const row = {
      ...addressed,
      id: id(53),
      issueIdentifier: 'OPE,"1',
      requestedResolverPolicy: "anyone",
      payload: {},
      projectId: null,
      casteKey: null,
      executionPolicy: null,
      projectLeadAgentId: null,
      reason: undefined,
      createdByUserId: null,
      escalationChain: undefined,
    };
    expect(JSON.parse(formatReport([row], "json"))).toEqual([row]);
    const csv = formatReport([row], "csv");
    expect(csv).toContain('"OPE,""1"');
    const csvLines = csv.trim().split("\n");
    expect(csvLines).toHaveLength(2);
    const cells = csvLines[1].split(",");
    // fields: id,issueIdentifier,kind,createdByAgentId,createdByUserId,requestedResolverPolicy,effectiveResolverPolicy,proposedRecipient,reason,escalationChain
    expect(cells[4]).toBe(""); // createdByUserId
    expect(cells[8]).toBe(""); // reason
    expect(cells[9]).toBe(""); // escalationChain
    expect(csv).not.toContain('""""');
  });

  describe("PostgreSQL read-only integration", () => {
    it("returns seven addressless cards from ten and preserves their table hash", async () => {
      const database = await startEmbeddedPostgresTestDatabase("interaction-readdress-report-");
      cleanups.push(() => database.cleanup());
      const db = createDb(database.connectionString);
      cleanups.push(() => db.$client.end());

      const companyId = id(9001);
      const projectId = id(9002);
      const issueId = id(9003);
      await db.execute(sql`
        INSERT INTO companies (id, name, issue_prefix)
        VALUES (${companyId}, 'Interaction readdress report test', 'IRR-REPORT-TEST')
      `);
      // Point 2 & 3: project with lead_agent_id = id(10) (lead only in lead_agent_id, not in project_memberships)
      await db.execute(sql`
        INSERT INTO projects (id, company_id, name, lead_agent_id)
        VALUES (${projectId}, ${companyId}, 'Readdress report fixture project', ${id(10)}::uuid)
      `);
      await db.execute(sql`
        INSERT INTO issues (id, company_id, title, identifier, project_id, caste_key)
        VALUES (${issueId}, ${companyId}, 'Readdress report fixture', 'IRR-1', ${projectId}, 'review')
      `);
      await db.execute(sql`
        INSERT INTO agents (id, company_id, name)
        VALUES (${id(1)}, ${companyId}, 'Creator'), (${id(2)}, ${companyId}, 'Existing recipient'),
               (${id(10)}, ${companyId}, 'Project Lead Only In LeadAgentId')
      `);

      await db.execute(sql`
        INSERT INTO agents (id, company_id, name)
        VALUES (${id(3)}, ${companyId}, 'Architect'), (${id(4)}, ${companyId}, 'Secondary reviewer')
      `);
      // Note: id(3) and id(4) are in project_memberships; id(10) is ONLY in projects.lead_agent_id
      await db.execute(sql`
        INSERT INTO project_memberships (company_id, project_id, user_id, state)
        VALUES (${companyId}, ${projectId}, ${id(3)}, 'joined'), (${companyId}, ${projectId}, ${id(4)}, 'joined')
      `);

      const inserts = Array.from({ length: 10 }, (_, index) => {
        const n = index + 1;
        const policy = n <= 4 ? "human_only" : n <= 7 ? "anyone" : "not_creator";
        const addressed = n === 2 || n === 6 || n === 9;
        const payload = n === 5 ? {
          routing: {
            routeType: "decision",
            projectRoles: {
              lead: { type: "agent", agentId: id(1), projectId, casteKey: "review", projectRoles: ["lead"] },
              architect: { type: "agent", agentId: id(3), projectId, casteKey: "review", projectRoles: ["architect"] },
              secondary_reviewer: { type: "agent", agentId: id(4), projectId, casteKey: "review", projectRoles: ["secondary_reviewer"] },
            },
            escalationPolicy: {
              participantRoles: ["lead", "architect", "secondary_reviewer"],
              fallbackQueue: "review-recovery",
              stepDelayMinutes: 30,
            },
          },
        } : n === 7 ? {
          // Point 3: card relying on project lead agent who is ONLY in projects.lead_agent_id
          routing: {
            routeType: "decision",
            projectRoles: {
              lead: { type: "agent", agentId: id(10), projectId, casteKey: "review", projectRoles: ["lead"] },
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
      expect(report.find((entry) => entry.id === id(5))?.proposedRecipient).toBe(`agent:${id(3)}`);
      expect(report.find((entry) => entry.id === id(5))?.escalationChain).toEqual([
        { recipient: `agent:${id(3)}`, afterMinutes: 0 },
        { recipient: `agent:${id(4)}`, afterMinutes: 30 },
        { recipient: "queue:review-recovery", afterMinutes: 60 },
      ]);
      // Card 7 has projectRoles.lead = id(10) (lead only in lead_agent_id, not in memberships)
      expect(report.find((entry) => entry.id === id(7))?.proposedRecipient).toBe(`agent:${id(10)}`);

      // Unresolved cards have reason set
      expect(report.filter((entry) => entry.id !== id(5) && entry.id !== id(7)).every((entry) => entry.proposedRecipient === "unresolved" && entry.reason)).toBe(true);
      expect(after).toBe(before);
    }, 90_000);
  });
});
