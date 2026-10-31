import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "./index.js";
import {
  applyReaddress,
  computeRouteType,
  computeTimeoutAt,
  formatApplySummary,
} from "./readdress-apply.js";
import { applyReaddress as applyReaddressFromScript } from "../../../scripts/myrmidon/interactions/readdress-apply.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

describe("readdress-apply", () => {
  describe("unit: computeRouteType and computeTimeoutAt", () => {
    it("computes routeType with fallback to decision", () => {
      expect(computeRouteType({ payload: { routing: { routeType: "code_review" } } } as any)).toBe("code_review");
      expect(computeRouteType({ payload: { routing: { routeType: "approval" } } } as any)).toBe("approval");
      expect(computeRouteType({ payload: { routing: { routeType: "operator_action" } } } as any)).toBe("operator_action");
      expect(computeRouteType({ payload: { routing: { routeType: "human_input" } } } as any)).toBe("human_input");
      expect(computeRouteType({ payload: { routing: { routeType: "custom" } } } as any)).toBe("decision");
      expect(computeRouteType({ payload: {} } as any)).toBe("decision");
    });

    it("computes timeoutAt from routing timeoutAt or stepDelayMinutes or fallback", () => {
      const now = new Date("2026-10-31T12:00:00.000Z");
      const explicit = computeTimeoutAt(
        { payload: { routing: { timeoutAt: "2026-11-01T00:00:00.000Z" } } } as any,
        now,
      );
      expect(explicit.toISOString()).toBe("2026-11-01T00:00:00.000Z");

      const delayed = computeTimeoutAt(
        { payload: { routing: { escalationPolicy: { stepDelayMinutes: 45 } } } } as any,
        now,
      );
      expect(delayed.getTime()).toBe(now.getTime() + 45 * 60_000);

      const fallback = computeTimeoutAt({ payload: {} } as any, now);
      expect(fallback.toISOString()).toBe("9999-12-31T23:59:59.000Z");
    });

    it("formats summary text, json, and csv", () => {
      const mockResult = {
        dryRun: true,
        totalCandidates: 2,
        appliedCount: 1,
        unresolvedCount: 1,
        skippedCount: 0,
        items: [
          {
            id: id(1),
            issueIdentifier: "ISS-1",
            proposedRecipient: `agent:${id(2)}`,
            routeType: "decision",
            timeoutAt: new Date("2026-10-31T12:30:00.000Z"),
            status: "dry_run" as const,
          },
          {
            id: id(2),
            issueIdentifier: "ISS-2",
            proposedRecipient: "unresolved",
            routeType: "",
            timeoutAt: new Date(0),
            status: "unresolved" as const,
            reason: "No eligible member",
          },
        ],
      };

      const text = formatApplySummary(mockResult, "text");
      expect(text).toContain("=== Interaction Readdress: DRY-RUN (no changes made) ===");
      expect(text).toContain("Total candidates: 2");
      expect(text).toContain("Proposed to apply: 1");

      const json = JSON.parse(formatApplySummary(mockResult, "json"));
      expect(json.totalCandidates).toBe(2);
      expect(json.items).toHaveLength(2);

      const csv = formatApplySummary(mockResult, "csv");
      expect(csv).toContain("id,issueIdentifier,status,proposedRecipient,routeType,timeoutAt,reason");
      expect(csv).toContain(id(1));
    });
  });

  describe("PostgreSQL integration", () => {
    const embeddedPostgres = getEmbeddedPostgresTestSupport();
    if (!embeddedPostgres.supported) {
      it.skip("requires embedded postgres", () => {});
      return;
    }

    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
      while (cleanups.length > 0) {
        const cleanup = cleanups.pop();
        if (cleanup) await cleanup();
      }
    });

    it("executes dry-run without changes, applies readdress with intact payload and journal, and is idempotent on repeat", async () => {
      const database = await startEmbeddedPostgresTestDatabase("interaction-readdress-apply-");
      cleanups.push(() => database.cleanup());
      const db = createDb(database.connectionString);
      cleanups.push(() => db.$client.end());

      const companyId = id(9001);
      const projectId = id(9002);
      const issueId = id(9003);

      await db.execute(sql`
        INSERT INTO companies (id, name, issue_prefix)
        VALUES (${companyId}, 'Interaction readdress apply test', 'IRR-APPLY-TEST')
      `);

      await db.execute(sql`
        INSERT INTO agents (id, company_id, name)
        VALUES (${id(1)}, ${companyId}, 'Creator'),
               (${id(2)}, ${companyId}, 'Existing recipient'),
               (${id(3)}, ${companyId}, 'Architect'),
               (${id(4)}, ${companyId}, 'Secondary reviewer'),
               (${id(10)}, ${companyId}, 'Project Lead Only In LeadAgentId')
      `);

      await db.execute(sql`
        INSERT INTO projects (id, company_id, name, lead_agent_id)
        VALUES (${projectId}, ${companyId}, 'Readdress apply fixture project', ${id(10)}::uuid)
      `);

      await db.execute(sql`
        INSERT INTO issues (id, company_id, title, identifier, project_id, caste_key)
        VALUES (${issueId}, ${companyId}, 'Readdress apply fixture', 'IRR-1', ${projectId}, 'review')
      `);

      await db.execute(sql`
        INSERT INTO project_memberships (company_id, project_id, user_id, state)
        VALUES (${companyId}, ${projectId}, ${id(3)}, 'joined'),
               (${companyId}, ${projectId}, ${id(4)}, 'joined')
      `);

      // Interactions 1..10 from report test + 11 for queue resolution
      const inserts = Array.from({ length: 11 }, (_, index) => {
        const n = index + 1;
        const policy = n <= 4 ? "human_only" : n <= 7 ? "anyone" : "not_creator";
        const addressed = n === 2 || n === 6 || n === 9;
        const payload: Record<string, unknown> =
          n === 5
            ? {
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
                extraContext: { originalKey: "fixture-5-untouched-payload" },
              }
            : n === 7
              ? {
                  routing: {
                    routeType: "decision",
                    projectRoles: {
                      lead: { type: "agent", agentId: id(10), projectId, casteKey: "review", projectRoles: ["lead"] },
                    },
                  },
                  extraContext: { originalKey: "fixture-7-untouched-payload" },
                }
              : n === 11
                ? {
                    routing: {
                      routeType: "approval",
                      policy: {
                        participantRoles: [],
                        fallbackQueue: "review-recovery",
                        stepDelayMinutes: 15,
                      },
                    },
                    extraContext: { originalKey: "fixture-11-untouched-payload" },
                  }
                : { prompt: `item-${n}`, testMeta: { preserved: true } };

        return sql`(\n          ${id(n)}::uuid, ${companyId}::uuid, ${issueId}::uuid, 'request_confirmation', 'pending',\n          ${`Title-${n}`}::text, ${`Summary-${n}`}::text, ${n >= 8 ? id(10) : id(1)}::uuid,\n          ${addressed ? id(2) : null}::uuid, ${null}::text, ${policy}, ${policy}, ${JSON.stringify(payload)}::jsonb\n        )`;
      });

      await db.execute(sql`
        INSERT INTO issue_thread_interactions (
          id, company_id, issue_id, kind, status, title, summary, created_by_agent_id,
          addressee_agent_id, addressee_user_id, requested_resolver_policy, effective_resolver_policy, payload
        ) VALUES ${sql.join(inserts, sql`, `)}
      `);

      // Record original state of cards
      const originalRows = (await db.execute(sql`
        SELECT id, payload, title, summary, result, addressee_agent_id, addressee_user_id, addressee_queue
        FROM issue_thread_interactions
        ORDER BY id
      `)) as unknown as Array<{
        id: string;
        payload: Record<string, unknown>;
        title: string;
        summary: string;
        result: unknown;
        addressee_agent_id: string | null;
        addressee_user_id: string | null;
        addressee_queue: string | null;
      }>;

      const originalPayloadMap = new Map(originalRows.map((r) => [r.id, JSON.stringify(r.payload)]));
      const originalTitleMap = new Map(originalRows.map((r) => [r.id, r.title]));
      const originalSummaryMap = new Map(originalRows.map((r) => [r.id, r.summary]));

      // 1. Dry run (default options, dryRun = true)
      const dryRunResult = await applyReaddress(db, { dryRun: true });
      expect(dryRunResult.dryRun).toBe(true);
      expect(dryRunResult.totalCandidates).toBe(8); // 1, 3, 4, 5, 7, 8, 10, 11
      expect(dryRunResult.appliedCount).toBe(3); // 5 -> agent:id(3), 7 -> agent:id(10), 11 -> queue:review-recovery
      expect(dryRunResult.unresolvedCount).toBe(5); // 1, 3, 4, 8, 10

      // Assert dry-run left the database completely unchanged
      const rowsAfterDryRun = (await db.execute(sql`
        SELECT id, addressee_agent_id, addressee_queue
        FROM issue_thread_interactions
        WHERE id IN (${id(5)}::uuid, ${id(7)}::uuid, ${id(11)}::uuid)
      `)) as unknown as Array<{ id: string; addressee_agent_id: string | null; addressee_queue: string | null }>;

      for (const row of rowsAfterDryRun) {
        expect(row.addressee_agent_id).toBeNull();
        expect(row.addressee_queue).toBeNull();
      }

      const journalAfterDryRun = (await db.execute(sql`
        SELECT COUNT(*)::int AS count FROM interaction_escalations
      `)) as unknown as Array<{ count: number }>;
      expect(journalAfterDryRun[0]!.count).toBe(0);

      // 2. Live apply (dryRun: false)
      const testNow = new Date("2026-10-31T14:00:00.000Z");
      const applyResult = await applyReaddress(db, { dryRun: false, now: testNow });
      expect(applyResult.dryRun).toBe(false);
      expect(applyResult.totalCandidates).toBe(8);
      expect(applyResult.appliedCount).toBe(3);
      expect(applyResult.unresolvedCount).toBe(5);

      // Verify targeted fixture cards have addressees and unchanged payload
      const rowsAfterApply = (await db.execute(sql`
        SELECT id, payload, title, summary, result, route_type, timeout_at,
               addressee_agent_id, addressee_user_id, addressee_queue
        FROM issue_thread_interactions
        ORDER BY id
      `)) as unknown as Array<{
        id: string;
        payload: Record<string, unknown>;
        title: string;
        summary: string;
        result: unknown;
        route_type: string | null;
        timeout_at: Date | string | null;
        addressee_agent_id: string | null;
        addressee_user_id: string | null;
        addressee_queue: string | null;
      }>;

      // Card 5 -> addressed to agent:id(3)
      const card5 = rowsAfterApply.find((r) => r.id === id(5))!;
      expect(card5.addressee_agent_id).toBe(id(3));
      expect(card5.addressee_user_id).toBeNull();
      expect(card5.addressee_queue).toBeNull();
      expect(card5.route_type).toBe("decision");
      expect(new Date(card5.timeout_at!).toISOString()).toBe(
        new Date(testNow.getTime() + 30 * 60_000).toISOString(),
      );

      // Card 7 -> addressed to agent:id(10)
      const card7 = rowsAfterApply.find((r) => r.id === id(7))!;
      expect(card7.addressee_agent_id).toBe(id(10));
      expect(card7.addressee_user_id).toBeNull();
      expect(card7.addressee_queue).toBeNull();
      expect(card7.route_type).toBe("decision");
      expect(card7.timeout_at).not.toBeNull();

      // Card 11 -> addressed to queue:review-recovery
      const card11 = rowsAfterApply.find((r) => r.id === id(11))!;
      expect(card11.addressee_agent_id).toBeNull();
      expect(card11.addressee_user_id).toBeNull();
      expect(card11.addressee_queue).toBe("review-recovery");
      expect(card11.route_type).toBe("approval");
      expect(new Date(card11.timeout_at!).toISOString()).toBe(
        new Date(testNow.getTime() + 15 * 60_000).toISOString(),
      );

      // Acceptance criterion: Payload byte-for-byte identical across ALL cards
      for (const row of rowsAfterApply) {
        expect(JSON.stringify(row.payload)).toBe(originalPayloadMap.get(row.id));
        expect(row.title).toBe(originalTitleMap.get(row.id));
        expect(row.summary).toBe(originalSummaryMap.get(row.id));
        expect(row.result).toBeNull();
      }

      // Acceptance criterion: Unresolved cards remain untouched
      const unresolvedIds = [id(1), id(3), id(4), id(8), id(10)];
      for (const uId of unresolvedIds) {
        const uCard = rowsAfterApply.find((r) => r.id === uId)!;
        expect(uCard.addressee_agent_id).toBeNull();
        expect(uCard.addressee_user_id).toBeNull();
        expect(uCard.addressee_queue).toBeNull();
        expect(uCard.route_type).toBeNull();
        expect(uCard.timeout_at).toBeNull();
      }

      // Verify journal entries in interaction_escalations
      const journalRows = (await db.execute(sql`
        SELECT interaction_id, level, from_recipient, to_recipient, reason
        FROM interaction_escalations
        ORDER BY interaction_id
      `)) as unknown as Array<{
        interaction_id: string;
        level: number;
        from_recipient: Record<string, unknown>;
        to_recipient: Record<string, unknown>;
        reason: string;
      }>;

      expect(journalRows).toHaveLength(3);

      const journal5 = journalRows.find((j) => j.interaction_id === id(5))!;
      expect(journal5.level).toBe(0);
      expect(journal5.from_recipient).toEqual({});
      expect(journal5.to_recipient).toEqual({ agentId: id(3) });
      expect(journal5.reason).toBe("readdress");

      const journal7 = journalRows.find((j) => j.interaction_id === id(7))!;
      expect(journal7.level).toBe(0);
      expect(journal7.from_recipient).toEqual({});
      expect(journal7.to_recipient).toEqual({ agentId: id(10) });
      expect(journal7.reason).toBe("readdress");

      const journal11 = journalRows.find((j) => j.interaction_id === id(11))!;
      expect(journal11.level).toBe(0);
      expect(journal11.from_recipient).toEqual({});
      expect(journal11.to_recipient).toEqual({ serviceQueue: "review-recovery" });
      expect(journal11.reason).toBe("readdress");

      // 3. Acceptance criterion: Repeated run -> 0 changes
      const repeatResult = await applyReaddress(db, { dryRun: false });
      expect(repeatResult.appliedCount).toBe(0);
      expect(repeatResult.totalCandidates).toBe(5); // only unresolved cards remain candidate
      expect(repeatResult.unresolvedCount).toBe(5);

      const journalAfterRepeat = (await db.execute(sql`
        SELECT COUNT(*)::int AS count FROM interaction_escalations
      `)) as unknown as Array<{ count: number }>;
      expect(journalAfterRepeat[0]!.count).toBe(3);

      // Verify re-export from scripts/myrmidon/interactions/readdress-apply.ts
      expect(typeof applyReaddressFromScript).toBe("function");
    });
  });
});
