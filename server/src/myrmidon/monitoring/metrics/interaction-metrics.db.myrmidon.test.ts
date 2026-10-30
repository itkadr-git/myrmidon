import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb, issues } from "@myrmidon/db";
import { sql } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../__tests__/helpers/embedded-postgres.js";
import { collectInteractionMetrics, interactionMetricsReadPort } from "./interaction-metrics.js";

const support = await getEmbeddedPostgresTestSupport();
if (process.env.CI && !support.supported) {
  throw new Error(`Interaction metrics PG acceptance requires PostgreSQL: ${support.reason}`);
}

(support.supported ? describe : describe.skip)("interaction SLA persisted I2/I3 rows", () => {
  vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("interaction-metrics-");
    db = createDb(database.connectionString);
  });
  afterAll(async () => { await database?.cleanup(); });
  it("reads real routing columns and escalation journal, including an ownerless card", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Interaction metrics", issuePrefix: "METRIC" });
    await db.insert(issues).values({ id: issueId, companyId, title: "SLA fixture" });
    const first = randomUUID();
    const second = randomUUID();
    // Deliberately use the real migration columns: absence must fail CI, not skip
    // or create a substitute schema that masks an incomplete I2/I3 integration.
    await db.execute(sql`
      INSERT INTO issue_thread_interactions
        (id, company_id, issue_id, kind, status, payload, created_at, timeout_at, escalation_level, addressee_queue)
      VALUES
        (${first}, ${companyId}, ${issueId}, 'ask_user_questions', 'pending', '{}'::jsonb,
          '2026-10-27T11:59:00Z', '2026-10-27T11:59:30Z', 0, NULL),
        (${second}, ${companyId}, ${issueId}, 'ask_user_questions', 'pending', '{}'::jsonb,
          '2026-10-27T11:58:00Z', '2026-10-27T11:59:30Z', 1, 'ops')
    `);
    await db.execute(sql`
      INSERT INTO interaction_escalations (company_id, interaction_id, level, from_recipient, to_recipient, reason)
      VALUES (${companyId}, ${second}, 1, '{}'::jsonb, '{"queue":"ops"}'::jsonb, 'timeout')
    `);
    const snapshot = await collectInteractionMetrics(interactionMetricsReadPort(db), new Date("2026-10-27T12:00:00Z"));
    expect(snapshot.pendingWithoutOwner).toBe(1);
    expect(snapshot.oldestPendingAgeSeconds).toBe(120);
    expect(snapshot.timeoutEscalatedRatio).toBe(0.5);
    expect(snapshot.escalations).toEqual([{ level: 1, count: 1 }]);
  });
});
