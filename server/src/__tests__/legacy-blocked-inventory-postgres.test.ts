import { randomUUID } from "node:crypto";
import { asc } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  closeRegisteredClients,
  companies,
  createDb,
  issueRelations,
  issueThreadInteractions,
  issues,
} from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { listLegacyBlocked } from "../../../scripts/myrmidon/legacy-blocked/inventory.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres legacy blocked inventory test on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("legacy blocked inventory", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-legacy-blocked-inventory-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    if (tempDb) {
      await closeRegisteredClients(tempDb.connectionString);
      await tempDb.cleanup();
    }
  });

  it("returns only eligible blocked issues and leaves all tables unchanged", async () => {
    const companyId = randomUUID();
    const eligibleId = randomUUID();
    const openBlockedId = randomUUID();
    const openBlockerId = randomUUID();
    const resolvedBlockedId = randomUUID();
    const resolvedBlockerId = randomUUID();
    const pendingInteractionId = randomUUID();
    const parentId = randomUUID();
    const metadataIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Legacy blocked inventory fixture",
      issuePrefix: `L${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values([
      { id: eligibleId, companyId, title: "Eligible blocked issue", status: "blocked" },
      { id: openBlockedId, companyId, title: "Issue with open blocker", status: "blocked" },
      { id: openBlockerId, companyId, parentId, title: "Open blocker child", status: "in_progress" },
      { id: resolvedBlockedId, companyId, title: "Issue with resolved blocker", status: "blocked" },
      { id: resolvedBlockerId, companyId, title: "Resolved blocker", status: "done" },
      { id: pendingInteractionId, companyId, title: "Issue with pending interaction", status: "blocked" },
      { id: parentId, companyId, title: "Blocked parent with child", status: "blocked" },
      {
        id: metadataIssueId,
        companyId,
        title: "Blocked issue with blocker metadata",
        status: "blocked",
        blockerMetadata: {
          blockReason: "external_wait",
          owner: { userId: randomUUID() },
          externalRef: "fixture:legacy-blocked-inventory",
          nextCheckAt: "2026-10-26T00:00:00.000Z",
          timeoutAt: "2026-10-27T00:00:00.000Z",
          escalationPolicy: "none",
        },
      },
    ]);
    await db.insert(issueRelations).values([
      {
        companyId,
        issueId: openBlockerId,
        relatedIssueId: openBlockedId,
        type: "blocks",
      },
      {
        companyId,
        issueId: resolvedBlockerId,
        relatedIssueId: resolvedBlockedId,
        type: "blocks",
      },
    ]);
    await db.insert(issueThreadInteractions).values({
      companyId,
      issueId: pendingInteractionId,
      kind: "ask_user_questions",
      status: "pending",
      payload: { version: 1, prompt: "Resolve this fixture interaction" },
    });

    const before = await snapshotTables();
    expect(before.issues).toHaveLength(8);

    const result = await listLegacyBlocked(db);
    const after = await snapshotTables();

    expect(result.map((issue) => issue.id).sort()).toEqual([eligibleId, resolvedBlockedId].sort());
    expect(after).toEqual(before);
  });

  async function snapshotTables() {
    return {
      companies: await db.select().from(companies).orderBy(asc(companies.id)),
      issues: await db.select().from(issues).orderBy(asc(issues.id)),
      issueRelations: await db.select().from(issueRelations).orderBy(asc(issueRelations.id)),
      issueThreadInteractions: await db
        .select()
        .from(issueThreadInteractions)
        .orderBy(asc(issueThreadInteractions.id)),
    };
  }
});
