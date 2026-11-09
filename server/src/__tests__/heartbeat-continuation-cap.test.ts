import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { runningProcesses } from "../adapters/index.ts";
import { CONTINUATION_CAP_COMMENT } from "../myrmidon/continuation-cap.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Continuation cap test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres continuation cap tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// myrmidon(OPE-11948): automatic `issue_continuation_needed` wakes are admitted
// only for a todo / in_progress issue assigned to the woken agent, and a loop of
// them stops after three continuation runs with no external input.
describeEmbeddedPostgres("heartbeat continuation wakes: status gate and real attempt cap (OPE-11948)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-continuation-cap-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    runningProcesses.clear();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await db.delete(environmentLeases);
        await db.delete(issueComments);
        await db.delete(issues);
        await db.delete(heartbeatRunEvents);
        await db.delete(activityLog);
        await db.delete(heartbeatRuns);
        await db.delete(agentWakeupRequests);
        await db.delete(agentRuntimeState);
        await db.delete(agents);
        await db.delete(environments);
        await db.delete(executionWorkspaces);
        await db.delete(companySkills);
        await db.delete(companies);
        break;
      } catch (error) {
        if (attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(companyId: string, name: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return agentId;
  }

  async function seedCompanyAgentIssue(status = "in_progress") {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    const agentId = await seedAgent(companyId, "CodexCoder");
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Standing operator ticket",
      status,
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });
    return { companyId, agentId, issueId };
  }

  const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

  async function seedContinuationRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    minutesAgo: number;
    status?: string;
  }) {
    const runId = randomUUID();
    const createdAt = minutesAgo(input.minutesAgo);
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: input.status ?? "succeeded",
      livenessState: "advanced",
      responsibleUserId: "responsible-user",
      createdAt,
      startedAt: createdAt,
      finishedAt: new Date(createdAt.getTime() + 60_000),
      contextSnapshot: {
        issueId: input.issueId,
        taskId: input.issueId,
        wakeReason: "issue_continuation_needed",
        retryReason: "issue_continuation_needed",
        source: "issue.continuation_recovery",
      },
    });
    return runId;
  }

  // Three succeeded continuation runs, oldest first: 50, 40 and 30 minutes ago.
  async function seedThreeContinuationRuns(ctx: { companyId: string; agentId: string; issueId: string }) {
    for (const minutes of [50, 40, 30]) await seedContinuationRun({ ...ctx, minutesAgo: minutes });
  }

  // What the recovery sweep sends in production: system actor, no actor id, a
  // retry-of run id as the recovery parent.
  function continuationWake(agentId: string, issueId: string) {
    const retryOfRunId = randomUUID();
    return heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_continuation_needed",
      payload: { issueId, retryOfRunId },
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_continuation_needed",
        retryReason: "issue_continuation_needed",
        source: "issue.continuation_recovery",
        retryOfRunId,
      },
      requestedByActorType: "system",
      requestedByActorId: null,
    });
  }

  // The recovery sweep's wake for an accepted interaction card: a person acted.
  function interactionContinuationWake(agentId: string, issueId: string) {
    const retryOfRunId = randomUUID();
    const interactionId = randomUUID();
    const interactionContext = {
      mutation: "interaction",
      interactionId,
      interactionKind: "request_confirmation",
      interactionStatus: "accepted",
      interactionResolvedAt: new Date().toISOString(),
    };
    return heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_continuation_needed",
      payload: { issueId, retryOfRunId, ...interactionContext },
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_continuation_needed",
        retryReason: "issue_continuation_needed",
        source: "issue.interaction_continuation_recovery",
        retryOfRunId,
        ...interactionContext,
      },
      requestedByActorType: "system",
      requestedByActorId: null,
    });
  }

  async function wakeRequests(agentId: string) {
    return db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
  }

  async function runCount(agentId: string) {
    return (await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId))).length;
  }

  function skippedWith(
    rows: Awaited<ReturnType<typeof wakeRequests>>,
    continuationSkipped: string,
  ) {
    return rows.filter(
      (row) =>
        row.status === "skipped" &&
        (row.payload as Record<string, unknown> | null)?.continuationSkipped === continuationSkipped,
    );
  }

  describe("status gate", () => {
    it.each(["backlog", "blocked", "in_review"])(
      "enqueues no continuation wake for a %s issue",
      async (status) => {
        const { agentId, issueId } = await seedCompanyAgentIssue(status);

        expect(await continuationWake(agentId, issueId)).toBeNull();

        expect(await runCount(agentId)).toBe(0);
        const skipped = skippedWith(await wakeRequests(agentId), "issue_not_actionable");
        expect(skipped).toHaveLength(1);
        expect(skipped[0]).toMatchObject({ reason: "issue_state_guard_mismatch" });
        expect(skipped[0]!.payload).toMatchObject({
          heartbeatSkip: { actualStatus: status, expectedStatuses: ["todo", "in_progress"] },
        });
      },
    );

    it.each(["done", "cancelled"])("enqueues no continuation wake for a %s issue", async (status) => {
      const { agentId, issueId } = await seedCompanyAgentIssue(status);

      expect(await continuationWake(agentId, issueId)).toBeNull();

      expect(await runCount(agentId)).toBe(0);
    });

    it("enqueues no continuation wake for an issue that was reassigned to another agent", async () => {
      const { companyId, agentId, issueId } = await seedCompanyAgentIssue("in_progress");
      const otherAgentId = await seedAgent(companyId, "OtherCoder");
      await db.update(issues).set({ assigneeAgentId: otherAgentId }).where(eq(issues.id, issueId));

      expect(await continuationWake(agentId, issueId)).toBeNull();

      expect(await runCount(agentId)).toBe(0);
      const skipped = skippedWith(await wakeRequests(agentId), "issue_not_actionable");
      expect(skipped).toHaveLength(1);
      expect(skipped[0]!.payload).toMatchObject({
        heartbeatSkip: { expectedAssigneeAgentId: agentId, actualAssigneeAgentId: otherAgentId },
      });
    });

    it.each(["todo", "in_progress"])("still admits a continuation wake for a %s issue", async (status) => {
      const { agentId, issueId } = await seedCompanyAgentIssue(status);

      expect(await continuationWake(agentId, issueId)).not.toBeNull();

      expect(skippedWith(await wakeRequests(agentId), "issue_not_actionable")).toHaveLength(0);
    });

    it("still lets a continuation that answers a resolved interaction card reach an in_review issue", async () => {
      const { agentId, issueId } = await seedCompanyAgentIssue("in_review");

      await interactionContinuationWake(agentId, issueId);

      expect(skippedWith(await wakeRequests(agentId), "issue_not_actionable")).toHaveLength(0);
    });

    it("keeps a blocked issue closed to an interaction continuation too", async () => {
      const { agentId, issueId } = await seedCompanyAgentIssue("blocked");

      expect(await interactionContinuationWake(agentId, issueId)).toBeNull();

      expect(await runCount(agentId)).toBe(0);
      expect(skippedWith(await wakeRequests(agentId), "issue_not_actionable")).toHaveLength(1);
    });
  });

  describe("real attempt cap", () => {
    it("stops after three continuations that only carry the agent's own activity, and parks the issue", async () => {
      const ctx = await seedCompanyAgentIssue("in_progress");
      const { companyId, agentId, issueId } = ctx;
      await seedThreeContinuationRuns(ctx);
      // The loop's own footprint: the agent's comment, its own status update,
      // and system bookkeeping. None of it is external input.
      await db.insert(issueComments).values({
        companyId, issueId, authorAgentId: agentId, authorType: "agent", body: "Still on it.", createdAt: minutesAgo(25),
      });
      await db.insert(issueComments).values({
        companyId, issueId, authorType: "system", body: "System bookkeeping note.", createdAt: minutesAgo(24),
      });
      await db.insert(activityLog).values([
        { companyId, actorType: "agent", actorId: agentId, agentId, action: "issue.comment_added", entityType: "issue", entityId: issueId, createdAt: minutesAgo(25) },
        { companyId, actorType: "agent", actorId: agentId, agentId, action: "issue.updated", entityType: "issue", entityId: issueId, createdAt: minutesAgo(22) },
        { companyId, actorType: "system", actorId: "heartbeat", action: "issue.updated", entityType: "issue", entityId: issueId, createdAt: minutesAgo(20) },
        { companyId, actorType: "agent", actorId: agentId, agentId, action: "issue.work_product_updated", entityType: "issue", entityId: issueId, createdAt: minutesAgo(18) },
      ]);

      expect(await continuationWake(agentId, issueId)).toBeNull();

      // No fourth continuation run, and the skip is on record.
      expect(await runCount(agentId)).toBe(3);
      const capSkips = skippedWith(await wakeRequests(agentId), "continuation_cap_reached");
      expect(capSkips).toHaveLength(1);
      expect(capSkips[0]).toMatchObject({ reason: "issue_rewake_throttled" });
      expect(capSkips[0]!.payload).toMatchObject({
        heartbeatSkip: { consecutiveContinuations: 3, maxContinuations: 3 },
      });
      // The issue is parked with a system comment in Russian.
      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(issue?.status).toBe("blocked");
      expect(issue?.blockerMetadata).toMatchObject({ blockReason: "human_decision" });
      const stopComments = (await db.select().from(issueComments).where(eq(issueComments.issueId, issueId)))
        .filter((comment) => comment.body === CONTINUATION_CAP_COMMENT);
      expect(stopComments).toHaveLength(1);
      expect(stopComments[0]).toMatchObject({ authorAgentId: null, authorUserId: null });
      const stopActivity = await db.select().from(activityLog).where(eq(activityLog.action, "issue.continuation_cap_reached"));
      expect(stopActivity).toHaveLength(1);

      // Nothing wakes it again until an external event.
      expect(await continuationWake(agentId, issueId)).toBeNull();
      expect(await runCount(agentId)).toBe(3);
      expect(skippedWith(await wakeRequests(agentId), "issue_not_actionable")).toHaveLength(1);
      expect(skippedWith(await wakeRequests(agentId), "continuation_cap_reached")).toHaveLength(1);
    });

    it.each<[string, (ctx: { companyId: string; agentId: string; issueId: string }) => Promise<void>]>([
      [
        "a user comment",
        async ({ companyId, issueId }) => {
          await db.insert(issueComments).values({
            companyId, issueId, authorUserId: "board-user", authorType: "user", body: "Please look at this.", createdAt: minutesAgo(35),
          });
        },
      ],
      [
        "a comment by a different agent",
        async ({ companyId, issueId }) => {
          const reviewerId = await seedAgent(companyId, "Reviewer");
          await db.insert(issueComments).values({
            companyId, issueId, authorAgentId: reviewerId, authorType: "agent", body: "Review notes.", createdAt: minutesAgo(35),
          });
        },
      ],
      [
        "a status change by a user",
        async ({ companyId, issueId }) => {
          await db.insert(activityLog).values({
            companyId, actorType: "user", actorId: "board-user", action: "issue.updated", entityType: "issue", entityId: issueId, createdAt: minutesAgo(35),
          });
        },
      ],
      [
        "a resolved blocker",
        async ({ companyId, issueId }) => {
          await db.insert(activityLog).values({
            companyId, actorType: "system", actorId: "system", action: "issue.blockers_resolved_wake_emitted", entityType: "issue", entityId: issueId, createdAt: minutesAgo(35),
          });
        },
      ],
      [
        "a PR sync event",
        async ({ companyId, issueId }) => {
          await db.insert(activityLog).values({
            companyId, actorType: "system", actorId: "task_pr_sync", action: "myrmidon.task_pr_sync.returned", entityType: "issue", entityId: issueId, createdAt: minutesAgo(35),
          });
        },
      ],
    ])("resets the counter after %s between the runs, and the continuation is admitted", async (_label, seedExternal) => {
      const ctx = await seedCompanyAgentIssue("in_progress");
      await seedThreeContinuationRuns(ctx);
      await seedExternal(ctx);

      expect(await continuationWake(ctx.agentId, ctx.issueId)).not.toBeNull();

      expect(skippedWith(await wakeRequests(ctx.agentId), "continuation_cap_reached")).toHaveLength(0);
      const [issue] = await db.select().from(issues).where(eq(issues.id, ctx.issueId));
      expect(issue?.blockerMetadata ?? null).toBeNull();
    });

    it("does not count a continuation that answers a resolved interaction card", async () => {
      const ctx = await seedCompanyAgentIssue("in_progress");
      await seedThreeContinuationRuns(ctx);

      await interactionContinuationWake(ctx.agentId, ctx.issueId);

      expect(skippedWith(await wakeRequests(ctx.agentId), "continuation_cap_reached")).toHaveLength(0);
      const [issue] = await db.select().from(issues).where(eq(issues.id, ctx.issueId));
      expect(issue?.blockerMetadata ?? null).toBeNull();
    });

    it("admits the third continuation: two earlier runs are below the cap", async () => {
      const ctx = await seedCompanyAgentIssue("in_progress");
      await seedContinuationRun({ ...ctx, minutesAgo: 40 });
      await seedContinuationRun({ ...ctx, minutesAgo: 30 });

      expect(await continuationWake(ctx.agentId, ctx.issueId)).not.toBeNull();

      expect(skippedWith(await wakeRequests(ctx.agentId), "continuation_cap_reached")).toHaveLength(0);
    });

    it("does not count failed or cancelled continuation runs: those have their own retry budget", async () => {
      const ctx = await seedCompanyAgentIssue("in_progress");
      await seedContinuationRun({ ...ctx, minutesAgo: 50 });
      await seedContinuationRun({ ...ctx, minutesAgo: 40, status: "failed" });
      await seedContinuationRun({ ...ctx, minutesAgo: 30, status: "cancelled" });

      expect(await continuationWake(ctx.agentId, ctx.issueId)).not.toBeNull();

      expect(skippedWith(await wakeRequests(ctx.agentId), "continuation_cap_reached")).toHaveLength(0);
    });

    // Vendor #15584 & #15847 (OPE-12206): a chain of continuations where each run
    // only produces the assignee's own comment (including empty comments or repeated
    // status-quo text) does not reset the counter and is capped after 3 continuations.
    it("vendor #15584+#15847: assignee's own comments (including empty comments) between continuations never reset the counter and are capped", async () => {
      const ctx = await seedCompanyAgentIssue("in_progress");
      const { companyId, agentId, issueId } = ctx;

      // First continuation run 50 minutes ago
      await seedContinuationRun({ ...ctx, minutesAgo: 50 });
      // Assignee posted an empty comment or status update
      await db.insert(issueComments).values({
        companyId,
        issueId,
        authorAgentId: agentId,
        authorType: "agent",
        body: "",
        createdAt: minutesAgo(45),
      });

      // Second continuation run 40 minutes ago
      await seedContinuationRun({ ...ctx, minutesAgo: 40 });
      // Assignee posted another comment without substantive external change
      await db.insert(issueComments).values({
        companyId,
        issueId,
        authorAgentId: agentId,
        authorType: "agent",
        body: "still working on this",
        createdAt: minutesAgo(35),
      });

      // Third continuation run 30 minutes ago
      await seedContinuationRun({ ...ctx, minutesAgo: 30 });
      // Assignee posted yet another comment
      await db.insert(issueComments).values({
        companyId,
        issueId,
        authorAgentId: agentId,
        authorType: "agent",
        body: "",
        createdAt: minutesAgo(20),
      });

      // 4th continuation attempt must be capped and park the issue as blocked
      expect(await continuationWake(agentId, issueId)).toBeNull();

      expect(await runCount(agentId)).toBe(3);
      const capSkips = skippedWith(await wakeRequests(agentId), "continuation_cap_reached");
      expect(capSkips).toHaveLength(1);
      expect(capSkips[0]).toMatchObject({ reason: "issue_rewake_throttled" });
      expect(capSkips[0]!.payload).toMatchObject({
        heartbeatSkip: { consecutiveContinuations: 3, maxContinuations: 3 },
      });

      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(issue?.status).toBe("blocked");
      expect(issue?.blockerMetadata).toMatchObject({ blockReason: "human_decision" });
    });
  });
});
