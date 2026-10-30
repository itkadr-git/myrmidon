// server/src/myrmidon/review-routing/store.db.myrmidon.test.ts
// SQL-backed regression coverage for review wake state reads.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, agentWakeupRequests, activityLog, heartbeatRuns, companies, createDb, issues } from "@myrmidon/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createPgReviewRoutingStore } from "./store.js";
import { REVIEW_ROUTING_WAKE_ACTION } from "@myrmidon/shared";

const embeddedSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("Postgres review routing wake state", () => {
  let cleanupDatabase: (() => Promise<void>) | undefined;
  let db: ReturnType<typeof createDb> | undefined;
  const companyId = randomUUID();
  const reviewerId = randomUUID();
  const issueIds: string[] = [];
  let activeIssueId: string | undefined;
  let queuedIssueId: string | undefined;
  let completedIssueId: string | undefined;

  beforeAll(async () => {
    const database = await startEmbeddedPostgresTestDatabase("review-routing-wake-state-");
    cleanupDatabase = database.cleanup;
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "review-routing-test", status: "active" });
    await db.insert(agents).values({ id: reviewerId, companyId, name: "reviewer", role: "reviewer", status: "idle", runtimeConfig: {} });
  }, 120_000);

  afterEach(async () => {
    if (db && companyId) {
      for (const issueId of issueIds) {
        await db.delete(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityId, issueId)));
      }
      await db.delete(activityLog).where(eq(activityLog.companyId, companyId));
      await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
      await db.delete(issues).where(eq(issues.companyId, companyId));
      issueIds.length = 0;
      activeIssueId = undefined;
      queuedIssueId = undefined;
      completedIssueId = undefined;
    }
  });

  afterAll(async () => {
    if (db) {
      await db.delete(agents).where(eq(agents.companyId, companyId));
      await db.delete(companies).where(eq(companies.id, companyId));
    }
    await cleanupDatabase?.();
  });

  async function makeIssue() {
    const id = randomUUID();
    await db!.insert(issues).values({ id, companyId, identifier: `TEST-${id.slice(0, 8)}`, title: "review wake state", status: "in_review", priority: "normal", executionState: { currentParticipant: { type: "agent", agentId: reviewerId } } });
    issueIds.push(id);
    return id;
  }

  it("reports active runs, pending wake requests, and the latest persisted wake", async () => {
    activeIssueId = await makeIssue();
    queuedIssueId = await makeIssue();
    completedIssueId = await makeIssue();
    const store = createPgReviewRoutingStore(db!);

    await db!.insert(heartbeatRuns).values({ companyId, agentId: reviewerId, invocationSource: "on_demand", status: "running", nativeIssueId: activeIssueId! });
    const active = await store.reviewWakeState({ companyId, issueId: activeIssueId!, reviewerAgentId: reviewerId, stageId: "review" });
    expect(active).toMatchObject({ activeRun: true, pendingWake: false, attempts: 0, lastWakeAt: null });

    await db!.insert(agentWakeupRequests).values({ companyId, agentId: reviewerId, status: "queued", source: "review", payload: { issueId: queuedIssueId! } });
    const pending = await store.reviewWakeState({ companyId, issueId: queuedIssueId!, reviewerAgentId: reviewerId, stageId: "review" });
    expect(pending).toMatchObject({ activeRun: false, pendingWake: true, attempts: 0, lastWakeAt: null });

    const lastWake = new Date(Date.now() - 60_000);
    await db!.insert(activityLog).values({ companyId, actorType: "system", actorId: "review_routing_sweep", action: REVIEW_ROUTING_WAKE_ACTION, entityType: "issue", entityId: completedIssueId!, details: { issueId: completedIssueId!, reviewerAgentId: reviewerId, stageId: "review", attempt: 3, requestedAt: lastWake.toISOString() } });
    const completed = await store.reviewWakeState({ companyId, issueId: completedIssueId!, reviewerAgentId: reviewerId, stageId: "review" });
    expect(completed.activeRun).toBe(false);
    expect(completed.pendingWake).toBe(false);
    expect(completed.attempts).toBe(3);
    expect(completed.lastWakeAt).toEqual(lastWake);
  });
});
