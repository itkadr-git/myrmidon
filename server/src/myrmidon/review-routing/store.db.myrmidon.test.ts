// server/src/myrmidon/review-routing/store.db.myrmidon.test.ts
// SQL-backed regression coverage for review wake state reads.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, agentWakeupRequests, activityLog, heartbeatRuns, companies, createDb, issueExecutionDecisions, issues, issueWorkProducts } from "@myrmidon/db";
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
    await db!.insert(heartbeatRuns).values({ companyId, agentId: reviewerId, invocationSource: "on_demand", status: "queued", nativeIssueId: queuedIssueId! });
    const active = await store.reviewWakeState({ companyId, issueId: activeIssueId!, reviewerAgentId: reviewerId, stageId: "review" });
    expect(active).toMatchObject({ activeRun: true, pendingWake: false, attempts: 0, lastWakeAt: null });
    expect(await store.countActiveRunsForAgent(companyId, reviewerId)).toBe(2);

    await db!.insert(agentWakeupRequests).values({ companyId, agentId: reviewerId, status: "queued", source: "review", payload: { issueId: queuedIssueId! } });
    const pending = await store.reviewWakeState({ companyId, issueId: queuedIssueId!, reviewerAgentId: reviewerId, stageId: "review" });
    expect(pending).toMatchObject({ activeRun: true, pendingWake: true, attempts: 0, lastWakeAt: null });

    await db!.insert(activityLog).values({ companyId, actorType: "system", actorId: "review_routing_sweep", action: REVIEW_ROUTING_WAKE_ACTION, entityType: "issue", entityId: completedIssueId!, details: { issueId: completedIssueId!, reviewerAgentId: reviewerId, stageId: "review", attempt: 3 } });
    const [persistedWake] = await db!.select({ createdAt: activityLog.createdAt }).from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityId, completedIssueId!), eq(activityLog.action, REVIEW_ROUTING_WAKE_ACTION))).limit(1);
    const completed = await store.reviewWakeState({ companyId, issueId: completedIssueId!, reviewerAgentId: reviewerId, stageId: "review" });
    expect(completed.activeRun).toBe(false);
    expect(completed.pendingWake).toBe(false);
    expect(completed.attempts).toBe(3);
    expect(completed.lastWakeAt).toEqual(persistedWake?.createdAt);
  });

  it("extracts the latest cancelled reviewer run timestamp for retry calculation and records escalations", async () => {
    const cancelledIssueId = await makeIssue();
    const store = createPgReviewRoutingStore(db!);
    const firstCancelledAt = new Date("2026-10-25T18:00:00.000Z");
    const secondCancelledAt = new Date("2026-10-25T18:15:00.000Z");

    await db!.insert(heartbeatRuns).values({
      companyId,
      agentId: reviewerId,
      invocationSource: "on_demand",
      status: "cancelled",
      nativeIssueId: cancelledIssueId,
      finishedAt: firstCancelledAt,
      createdAt: firstCancelledAt,
    });

    let state = await store.reviewWakeState({ companyId, issueId: cancelledIssueId, reviewerAgentId: reviewerId, stageId: "review" });
    expect(state.activeRun).toBe(false);
    expect(state.lastCancelledRunAt).toEqual(firstCancelledAt);

    // Repeated cancellation: verify the newer cancelled run timestamp is returned
    await db!.insert(heartbeatRuns).values({
      companyId,
      agentId: reviewerId,
      invocationSource: "on_demand",
      status: "cancelled",
      nativeIssueId: cancelledIssueId,
      finishedAt: secondCancelledAt,
      createdAt: secondCancelledAt,
    });

    state = await store.reviewWakeState({ companyId, issueId: cancelledIssueId, reviewerAgentId: reviewerId, stageId: "review" });
    expect(state.lastCancelledRunAt).toEqual(secondCancelledAt);

    // Verify recordReviewWakeEscalation persists escalation in activityLog
    await store.recordReviewWakeEscalation({
      companyId,
      issueId: cancelledIssueId,
      reviewerAgentId: reviewerId,
      stageId: "review",
      attempts: 5,
      at: secondCancelledAt,
    });

    const [escalation] = await db!.select()
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.entityId, cancelledIssueId),
        eq(activityLog.action, "issue.review_routing.wake_escalation_required"),
      ))
      .limit(1);

    expect(escalation).toBeDefined();
    expect((escalation?.details as Record<string, unknown>)?.owner).toBe("ADM");
    expect((escalation?.details as Record<string, unknown>)?.attempts).toBe(5);
  });
});

// myrmidon(OPE-11767): the stored half of the board-side merge — which tasks
// have an approved review stage and an open pull request, and the guarded
// return of such a task to its implementer.
describeEmbeddedPostgres("Postgres review routing board merge", () => {
  let cleanupDatabase: (() => Promise<void>) | undefined;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const reviewerId = randomUUID();
  const implementerId = randomUUID();
  const SHA = "28f15c1be15204153f0e06464842d88875c373f8";

  beforeAll(async () => {
    const database = await startEmbeddedPostgresTestDatabase("review-routing-board-merge-");
    cleanupDatabase = database.cleanup;
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "board-merge-test", status: "active" });
    await db.insert(agents).values([
      { id: reviewerId, companyId, name: "reviewer", role: "reviewer", status: "idle", runtimeConfig: {} },
      { id: implementerId, companyId, name: "implementer", role: "engineer", status: "idle", runtimeConfig: {} },
    ]);
  }, 120_000);

  afterEach(async () => {
    // The decisions and work products go with their issues (cascade).
    await db.delete(issues).where(eq(issues.companyId, companyId));
  });

  afterAll(async () => {
    if (db) {
      await db.delete(agents).where(eq(agents.companyId, companyId));
      await db.delete(companies).where(eq(companies.id, companyId));
    }
    await cleanupDatabase?.();
  });

  async function approvedIssue(input: {
    status?: string;
    state?: Record<string, unknown> | null;
    verdict?: string | null;
    withDecisionId?: boolean;
    products?: Array<{ status?: string; url?: string | null; metadata?: Record<string, unknown> | null }>;
  }) {
    const id = randomUUID();
    const decisionId = randomUUID();
    const withDecision = input.verdict !== null && input.verdict !== undefined;
    const state =
      input.state === undefined
        ? {
            status: "completed",
            lastDecisionOutcome: "approved",
            ...(withDecision && input.withDecisionId !== false ? { lastDecisionId: decisionId } : {}),
            returnAssignee: { type: "agent", agentId: implementerId },
          }
        : input.state;
    await db.insert(issues).values({
      id,
      companyId,
      identifier: `TEST-${id.slice(0, 8)}`,
      title: "approved pull request",
      status: input.status ?? "in_review",
      priority: "normal",
      assigneeAgentId: reviewerId,
      executionState: state,
    });
    if (withDecision) {
      await db.insert(issueExecutionDecisions).values({
        id: decisionId,
        companyId,
        issueId: id,
        stageId: randomUUID(),
        stageType: "review",
        actorAgentId: reviewerId,
        outcome: "approved",
        body: input.verdict!,
      });
    }
    for (const product of input.products ?? [{ metadata: { repo: "acme/widgets", number: 7 } }]) {
      await db.insert(issueWorkProducts).values({
        companyId,
        issueId: id,
        type: "pull_request",
        provider: "github",
        title: "PR",
        status: product.status ?? "open",
        url: product.url ?? null,
        metadata: product.metadata ?? null,
      });
    }
    return id;
  }

  it("lists tasks with an approved stage and an open PR, with the approving verdict, one row per PR", async () => {
    const verdict = `APPROVE PR #7 ${SHA}`;
    const inReview = await approvedIssue({
      verdict,
      // The same PR recorded twice (repeated work products) is one row.
      products: [{ metadata: { repo: "acme/widgets", number: 7 } }, { url: "https://github.com/acme/widgets/pull/7" }],
    });
    // After the guard-return the task is with the author, the stage state says so; the PR is known by its URL only.
    const withAuthor = await approvedIssue({
      status: "in_progress",
      state: { status: "in_progress", lastDecisionOutcome: "approved", returnAssignee: { type: "agent", agentId: implementerId } },
      verdict: `APPROVE PR #8 ${SHA}`,
      withDecisionId: false,
      products: [{ url: "https://github.com/acme/widgets/pull/8", status: "ready_for_review" }],
    });
    // Not ours: merged PR, changes requested, a review still pending, a task that is not in review/progress.
    await approvedIssue({ verdict, products: [{ status: "merged", metadata: { repo: "acme/widgets", number: 9 } }] });
    await approvedIssue({
      verdict,
      state: { status: "changes_requested", lastDecisionOutcome: "changes_requested" },
      products: [{ metadata: { repo: "acme/widgets", number: 10 } }],
    });
    await approvedIssue({
      verdict,
      state: { status: "pending", currentStageType: "review", lastDecisionOutcome: null },
      products: [{ metadata: { repo: "acme/widgets", number: 11 } }],
    });
    await approvedIssue({ status: "done", verdict, products: [{ metadata: { repo: "acme/widgets", number: 12 } }] });

    const store = createPgReviewRoutingStore(db);
    const rows = await store.listApprovedPrIssues(companyId);
    expect(rows.map((row) => [row.issueId, row.repository, row.number]).sort()).toEqual(
      [
        [inReview, "acme/widgets", 7],
        [withAuthor, "acme/widgets", 8],
      ].sort(),
    );
    expect(rows.find((row) => row.issueId === inReview)).toMatchObject({ verdict, status: "in_review" });
    // A state without `lastDecisionId` still finds its approving decision: the task's latest approved one.
    expect(rows.find((row) => row.issueId === withAuthor)).toMatchObject({ verdict: `APPROVE PR #8 ${SHA}`, status: "in_progress" });

    expect(await store.listApprovedPrIssues(companyId, { issueId: inReview })).toHaveLength(1);
    expect(await store.listApprovedPrIssues(companyId, { limit: 1 })).toHaveLength(1);
  });

  it("returns an approved task to its implementer once, under the lock", async () => {
    const id = await approvedIssue({ verdict: `APPROVE PR #7 ${SHA}` });
    const store = createPgReviewRoutingStore(db);
    const at = new Date("2026-11-06T08:00:00.000Z");

    const returned = await store.returnApprovedPrToImplementer({ companyId, issueId: id, at });
    expect(returned).toMatchObject({ implementerAgentId: implementerId, previousStatus: "in_review" });

    const [row] = await db.select().from(issues).where(eq(issues.id, id));
    expect(row).toMatchObject({ status: "in_progress", assigneeAgentId: implementerId });
    expect(row!.executionState).toMatchObject({ status: "changes_requested", lastDecisionOutcome: "changes_requested", reviewRequest: null });

    // The approval no longer stands: neither a second call nor the listing sees the task again.
    expect(await store.returnApprovedPrToImplementer({ companyId, issueId: id, at })).toBeNull();
    expect(await store.listApprovedPrIssues(companyId, { issueId: id })).toEqual([]);
  });

  it("does not move a task whose approval does not stand, or whose implementer is a person", async () => {
    const store = createPgReviewRoutingStore(db);
    const at = new Date();
    const pending = await approvedIssue({ state: { status: "pending", currentStageType: "review", lastDecisionOutcome: null } });
    const done = await approvedIssue({ status: "done" });
    const byPerson = await approvedIssue({
      state: { status: "completed", lastDecisionOutcome: "approved", returnAssignee: { type: "user", userId: "u1" } },
    });
    for (const issueId of [pending, done, byPerson]) {
      expect(await store.returnApprovedPrToImplementer({ companyId, issueId, at })).toBeNull();
    }
    const [unchanged] = await db.select().from(issues).where(eq(issues.id, pending));
    expect(unchanged!.status).toBe("in_review");
  });
});
