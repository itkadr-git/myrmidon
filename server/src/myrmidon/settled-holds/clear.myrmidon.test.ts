// myrmidon(L2): clearSettledReplayBlock — see clear.ts.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { activityLog, agents, companies, createDb, issueRecoveryActions, issues, issueThreadInteractions } from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { publishActivity, type ActivityPublication } from "../../services/activity-log.js";
import { subscribeCompanyLiveEvents } from "../../services/live-events.js";
import {
  clearExpiredReplayHolds,
  clearSettledReplayBlock,
  clearSettledReplayHoldsForIssue,
  clearSettledReplayHoldsOnAuthoritativeRunSuccess,
} from "./clear.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("clearSettledReplayBlock (L2)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-settled-holds-clear-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "user-a",
      requireBoardApprovalForNewAgents: false,
    });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId, companyId, name: "agent-a", role: "engineer", status: "idle",
      adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    const [issue] = await db.insert(issues).values({
      companyId, title: "held", status: "blocked", priority: "medium", assigneeAgentId: agentId,
    }).returning();
    const runId = randomUUID();
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId, sourceIssueId: issue!.id, kind: "execution_reconciliation", status: "resolved",
      outcome: "blocked", cause: "uncertain_provider_action", fingerprint: randomUUID(),
      evidence: { runId, actionOutcome: "unknown", automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } },
      nextAction: "Automatic recovery stopped.",
    }).returning();
    return { companyId, issueId: issue!.id, agentId, action: action! };
  }

  it("sets replay to cleared, keeps other evidence, and records who/when/note", async () => {
    const { companyId, action } = await seed();
    const cleared = await clearSettledReplayBlock({
      db, companyId, action, actor: { actorType: "user", actorId: "board" },
      note: "Provider process confirmed stopped; no remaining effects.",
    });

    expect(cleared.evidence).toMatchObject({
      runId: action.evidence.runId,
      actionOutcome: "unknown",
      automaticRecovery: {
        replay: "cleared",
        actionOutcome: "unknown",
        replayClearedBy: "board",
        replayClearedByType: "user",
        replayClearedNote: "Provider process confirmed stopped; no remaining effects.",
      },
    });
    expect(typeof (cleared.evidence.automaticRecovery as Record<string, unknown>).replayClearedAt).toBe("string");
    // status/outcome/resolvedAt stay untouched — only the disposition and evidence move.
    expect(cleared.status).toBe("resolved");
    expect(cleared.outcome).toBe("blocked");

    const [persisted] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
    expect(persisted!.evidence).toEqual(cleared.evidence);
  });

  it("writes a durable activity log entry", async () => {
    const { companyId, issueId, action } = await seed();
    await clearSettledReplayBlock({
      db, companyId, action, actor: { actorType: "user", actorId: "board" }, note: null,
    });

    const [entry] = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
    expect(entry).toMatchObject({
      companyId, actorType: "user", actorId: "board",
      action: "issue.execution_recovery_replay_cleared", entityType: "issue", entityId: issueId,
    });
    expect(entry!.details).toMatchObject({ recoveryActionId: action.id, cause: action.cause, recoveryActionStatus: "resolved" });
  });

  it("publishes the activity.logged live event immediately when no deferred array is given", async () => {
    const { companyId, action } = await seed();
    const events: unknown[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => {
      if (event.type === "activity.logged") events.push(event);
    });
    try {
      await clearSettledReplayBlock({
        db, companyId, action, actor: { actorType: "user", actorId: "board" }, note: null,
      });
    } finally {
      unsubscribe();
    }
    expect(events).toHaveLength(1);
  });

  it("defers the live event into the given array instead of publishing before the caller's transaction commits", async () => {
    const { companyId, action } = await seed();
    const events: unknown[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => {
      if (event.type === "activity.logged") events.push(event);
    });
    const postCommitActivityPublications: ActivityPublication[] = [];
    try {
      await clearSettledReplayBlock({
        db, companyId, action, actor: { actorType: "user", actorId: "board" }, note: null,
        postCommitActivityPublications,
      });
      // Not published yet: a caller inside a DB transaction queues the event
      // here and flushes it only after the transaction is known to commit.
      expect(events).toHaveLength(0);
      expect(postCommitActivityPublications).toHaveLength(1);
      for (const publication of postCommitActivityPublications) publishActivity(publication);
      expect(events).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });

  it("throws instead of silently returning an unwritten record when the action id no longer matches a row", async () => {
    const { companyId, action } = await seed();
    await expect(
      clearSettledReplayBlock({
        db, companyId, action: { ...action, id: randomUUID() },
        actor: { actorType: "user", actorId: "board" }, note: null,
      }),
    ).rejects.toThrow(/not found/);
  });

  it("clears all settled replay holds for an issue (e.g. on run success)", async () => {
    const { companyId, issueId, action } = await seed();
    const clearedIds = await clearSettledReplayHoldsForIssue(
      db,
      companyId,
      issueId,
      { actorType: "agent", actorId: "test-agent" },
      "run succeeded",
    );
    expect(clearedIds).toContain(action.id);
    const [persisted] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
    expect((persisted!.evidence as any).automaticRecovery.replay).toBe("cleared");
  });

  it("clears expired replay holds older than 24 hours on safe workable tasks", async () => {
    const { companyId, issueId, action } = await seed();
    // Age the recovery action past 24 hours
    await db
      .update(issueRecoveryActions)
      .set({ createdAt: sql`now() - interval '25 hours'` })
      .where(eq(issueRecoveryActions.id, action.id));

    const clearedCount = await clearExpiredReplayHolds(db);
    expect(clearedCount).toBeGreaterThanOrEqual(1);
    const [persisted] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
    expect((persisted!.evidence as any).automaticRecovery.replay).toBe("cleared");
    expect((persisted!.evidence as any).automaticRecovery.replayClearedNote).toContain("expired (>24h");
  });

  it("leaves expired replay hold intact if task is blocked or has side effects/external wait", async () => {
    // 1. Task in blocked status
    const { companyId, issueId: blockedIssueId, action: blockedAction } = await seed();
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, blockedIssueId));
    await db
      .update(issueRecoveryActions)
      .set({ createdAt: sql`now() - interval '25 hours'` })
      .where(eq(issueRecoveryActions.id, blockedAction.id));

    // 2. Task in in_review status
    const { issueId: reviewIssueId, action: reviewAction } = await seed();
    await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, reviewIssueId));
    await db
      .update(issueRecoveryActions)
      .set({ createdAt: sql`now() - interval '25 hours'` })
      .where(eq(issueRecoveryActions.id, reviewAction.id));

    // 3. Task with unblockDescriptor
    const { issueId: descIssueId, action: descAction } = await seed();
    await db
      .update(issues)
      .set({ unblockDescriptor: { reason: "waiting on human", owner: { userId: randomUUID() } } })
      .where(eq(issues.id, descIssueId));
    await db
      .update(issueRecoveryActions)
      .set({ createdAt: sql`now() - interval '25 hours'` })
      .where(eq(issueRecoveryActions.id, descAction.id));

    // 4. Task with pending thread interaction
    const { issueId: pendingInterIssueId, action: pendingInterAction } = await seed();
    await db.insert(issueThreadInteractions).values({
      id: randomUUID(),
      companyId,
      issueId: pendingInterIssueId,
      status: "pending",
      kind: "request_confirmation",
      payload: { version: 1, prompt: "confirm?" } as any,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db
      .update(issueRecoveryActions)
      .set({ createdAt: sql`now() - interval '25 hours'` })
      .where(eq(issueRecoveryActions.id, pendingInterAction.id));

    await clearExpiredReplayHolds(db);

    const [persistedBlocked] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, blockedAction.id));
    expect((persistedBlocked!.evidence as any).automaticRecovery.replay).toBe("blocked");

    const [persistedReview] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, reviewAction.id));
    expect((persistedReview!.evidence as any).automaticRecovery.replay).toBe("blocked");

    const [persistedDesc] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, descAction.id));
    expect((persistedDesc!.evidence as any).automaticRecovery.replay).toBe("blocked");

    const [persistedPendingInter] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, pendingInterAction.id));
    expect((persistedPendingInter!.evidence as any).automaticRecovery.replay).toBe("blocked");
  });

  describe("clearSettledReplayHoldsOnAuthoritativeRunSuccess", () => {
    it("clears hold when run succeeded and matches current authoritative assignee", async () => {
      const { companyId, issueId, agentId, action } = await seed();
      const run = {
        id: randomUUID(),
        companyId,
        agentId,
        status: "succeeded",
      };
      const issue = {
        id: issueId,
        assigneeAgentId: agentId,
        assigneeUserId: null,
        status: "in_progress",
      };

      const result = await clearSettledReplayHoldsOnAuthoritativeRunSuccess(db, run, issue);
      expect(result).toContain(action.id);

      const [persisted] = await db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.id, action.id));
      expect((persisted!.evidence as any).automaticRecovery.replay).toBe("cleared");
    });

    it("leaves hold intact when run is stale/non-current (assignee mismatch)", async () => {
      const { companyId, issueId, action } = await seed();
      const run = {
        id: randomUUID(),
        companyId,
        agentId: "stale-past-agent",
        status: "succeeded",
      };
      const issue = {
        id: issueId,
        assigneeAgentId: "current-new-agent",
        assigneeUserId: null,
        status: "in_progress",
      };

      const result = await clearSettledReplayHoldsOnAuthoritativeRunSuccess(db, run, issue);
      expect(result).toBeNull();

      const [persisted] = await db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.id, action.id));
      expect((persisted!.evidence as any).automaticRecovery.replay).toBe("blocked");
    });

    it("leaves hold intact when issue is assigned to a user", async () => {
      const { companyId, issueId, agentId, action } = await seed();
      const run = {
        id: randomUUID(),
        companyId,
        agentId,
        status: "succeeded",
      };
      const issue = {
        id: issueId,
        assigneeAgentId: agentId,
        assigneeUserId: "some-user-id",
        status: "in_progress",
      };

      const result = await clearSettledReplayHoldsOnAuthoritativeRunSuccess(db, run, issue);
      expect(result).toBeNull();

      const [persisted] = await db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.id, action.id));
      expect((persisted!.evidence as any).automaticRecovery.replay).toBe("blocked");
    });

    it("does not clear hold if run started before hold was created (OPE-7707)", async () => {
      const { companyId, issueId, agentId, action } = await seed();
      const run = {
        id: randomUUID(),
        companyId,
        agentId,
        status: "succeeded",
        startedAt: new Date(new Date(action.createdAt).getTime() - 60_000), // 1 min before hold
      };
      const issue = {
        id: issueId,
        assigneeAgentId: agentId,
        assigneeUserId: null,
        status: "in_progress",
      };

      const result = await clearSettledReplayHoldsOnAuthoritativeRunSuccess(db, run, issue);
      expect(result).toEqual([]);

      const [persisted] = await db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.id, action.id));
      expect((persisted!.evidence as any).automaticRecovery.replay).toBe("blocked");
    });

    it("clears hold if run started after hold was created (OPE-7707)", async () => {
      const { companyId, issueId, agentId, action } = await seed();
      const run = {
        id: randomUUID(),
        companyId,
        agentId,
        status: "succeeded",
        startedAt: new Date(new Date(action.createdAt).getTime() + 60_000), // 1 min after hold
      };
      const issue = {
        id: issueId,
        assigneeAgentId: agentId,
        assigneeUserId: null,
        status: "in_progress",
      };

      const result = await clearSettledReplayHoldsOnAuthoritativeRunSuccess(db, run, issue);
      expect(result).toEqual([action.id]);

      const [persisted] = await db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.id, action.id));
      expect((persisted!.evidence as any).automaticRecovery.replay).toBe("cleared");
    });
  });
});
