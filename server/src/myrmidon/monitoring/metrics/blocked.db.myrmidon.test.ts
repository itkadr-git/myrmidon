import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issues, type Db } from "@myrmidon/db";
import { eq } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../__tests__/helpers/embedded-postgres.js";
import { collectBlockedMetrics } from "./blocked.js";

const support = await getEmbeddedPostgresTestSupport();
if (process.env.CI && !support.supported) {
  throw new Error(`Blocked metrics PG acceptance requires PostgreSQL: ${support.reason}`);
}

(support.supported ? describe : describe.skip)("blocked metrics PG acceptance", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const now = new Date("2026-10-27T08:00:00Z");
  const complete = {
    blockReason: "dependency" as const,
    owner: { agentId: randomUUID() },
    nextCheckAt: "2026-10-28T08:00:00Z",
    timeoutAt: "2026-10-29T08:00:00Z",
    escalationPolicy: "notify_owner",
  };

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-blocked-metrics-");
    db = createDb(database.connectionString);
    await db.insert(companies).values([
      { id: companyId, name: "Blocked Metrics", issuePrefix: "BM" },
      { id: otherCompanyId, name: "Other Metrics", issuePrefix: "OM" },
    ]);
    await db.insert(issues).values([
      ...[10, 20, 30].map((age) => ({
        companyId, title: `Complete ${age}`, status: "blocked",
        blockerMetadata: complete,
        blockedTransitionAt: new Date(now.getTime() - age * 1000),
      })),
      {
        companyId, title: "Missing owner and next check", status: "blocked",
        blockerMetadata: { ...complete, owner: { agentId: "" }, nextCheckAt: "" },
        blockedTransitionAt: new Date(now.getTime() - 40_000),
      },
      {
        companyId, title: "Missing reason and next check", status: "blocked",
        // Simulate historically incomplete JSON while preserving the public write type.
        blockerMetadata: { ...complete, blockReason: null, nextCheckAt: "" } as unknown as typeof complete,
        blockedTransitionAt: new Date(now.getTime() - 50_000),
      },
      { companyId, title: "Legacy", status: "blocked", blockedTransitionAt: new Date(now.getTime() - 1_000_000) },
      { companyId, title: "Done", status: "done", blockedTransitionAt: new Date(0) },
      { companyId: otherCompanyId, title: "Other company", status: "blocked", blockedTransitionAt: new Date(0) },
    ]);
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  }, 60_000);

  it("reads persisted JSON and timestamps through the typed port and separates legacy", async () => {
    const groups = await collectBlockedMetrics(async (id) => ({
      blockedIssues: await db.select({
        id: issues.id,
        status: issues.status,
        blockerMetadata: issues.blockerMetadata,
        blockedSince: issues.blockedTransitionAt,
      }).from(issues).where(eq(issues.companyId, id)),
    }), companyId, now);
    expect(groups).toEqual([
      { legacy: false, count: 5, ageSeconds: { p50: 30, p95: 50, max: 50 }, missingFields: { reason: 1, owner: 1, nextCheckAt: 2 } },
      { legacy: true, count: 1, ageSeconds: { p50: 1000, p95: 1000, max: 1000 }, missingFields: { reason: 1, owner: 1, nextCheckAt: 1 } },
    ]);
  });
});
