// server/src/myrmidon/review-routing/store.db.myrmidon.test.ts
// SQL-backed regression coverage for review wake state reads.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, agentWakeupRequests, activityLog, heartbeatRuns, companies, createDb, issues } from "@myrmidon/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createPgReviewRoutingStore } from "./store.js";

const support = await getEmbeddedPostgresTestSupport();
const describeWithDb = support.supported ? describe : describe.skip;

describeWithDb("review routing SQL wake state", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let companyId: string;
  let reviewerId: string;
  const issueIds: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("review-routing-wake-");
    db = createDb(tempDb.connectionString);
    const [company] = await db.insert(companies).values({ name: `wake-${randomUUID()}`, issuePrefix: `RW${randomUUID().slice(0, 8).toUpperCase()}` }).returning();
    companyId = company!.id;
    const [reviewer] = await db.insert(agents).values({ companyId, name: `reviewer-${randomUUID()}`, role: "reviewer" }).returning();
    reviewerId = reviewer!.id;
  }, 60_000);

  afterEach(async () => {
    if (issueIds.length) await db.delete(issues).where(eq(issues.companyId, companyId));
    issueIds.length = 0;
  });

  afterAll(async () => {
    if (db && companyId) {
      await db.delete(activityLog).where(eq(activityLog.companyId, companyId));
      await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
      await db.delete(issues).where(eq(issues.companyId, companyId));
      await db.delete(agents).where(eq(agents.companyId, companyId));
      await db.delete(companies).where(eq(companies.id, companyId));
    }
    await tempDb?.cleanup();
  });

  async function makeIssue() {
    const [issue] = await db.insert(issues).values({ companyId, title: `wake-state-${randomUUID()}`, status: "in_review", assigneeAgentId: reviewerId }).returning();
    issueIds.push(issue!.id);
    return issue!.id;
  }

  it("reads active run, queued wake, and last wake facts from SQL", async () => {
    const activeIssueId = await makeIssue();
    const queuedIssueId = await makeIssue();
    const completedIssueId = await makeIssue();
    const store = createPgReviewRoutingStore(db);

    await db.insert(heartbeatRuns).values({ companyId, agentId: reviewerId, invocationSource: "on_demand", status: "running", nativeIssueId: activeIssueId });
    const active = await store.reviewWakeState({ companyId, issueId: activeIssueId, reviewerAgentId: reviewerId, stageId: "review" });
    expect(active.activeRun).toBe(true);
    expect(active.pendingWake).toBe(false);
    expect(active.lastWakeAt).toBeNull();

    await db.insert(agentWakeupRequests).values({ companyId, agentId: reviewerId, source: "test", payload: { issueId: queuedIssueId }, status: "queued" });
    const queued = await store.reviewWakeState({ companyId, issueId: queuedIssueId, reviewerAgentId: reviewerId, stageId: "review" });
    expect(queued.pendingWake).toBe(true);

    const lastWake = new Date("2026-10-26T06:10:00.000Z");
    await store.recordReviewWake({ companyId, issueId: completedIssueId, reviewerAgentId: reviewerId, stageId: "review", at: lastWake, attempt: 2 });
    const completed = await store.reviewWakeState({ companyId, issueId: completedIssueId, reviewerAgentId: reviewerId, stageId: "review" });
    expect(completed.activeRun).toBe(false);
    expect(completed.pendingWake).toBe(false);
    expect(completed.attempts).toBe(2);
    expect(completed.lastWakeAt).toEqual(lastWake);
  });
});
