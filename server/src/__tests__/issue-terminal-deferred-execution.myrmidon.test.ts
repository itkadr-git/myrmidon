// myrmidon(DEFERRED-WAKE-LEAK): tests for OPE-8490
// 1. When an issue transitions to done/cancelled, all its deferred_issue_execution
//    wakes are cancelled with error "issue_closed".
// 2. A queued-comment-interrupt on a closed task triggers issue_state_guard_mismatch (skipped)
//    once and cancels the source deferred wakeup, preventing infinite retries.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { heartbeatService } from "../services/heartbeat.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Deferred wake terminal issue test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.js", async () => {
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
    `Skipping embedded Postgres terminal deferred execution tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("deferred wakeups on terminal issues (OPE-8490)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let heartbeat!: ReturnType<typeof heartbeatService>;

  const companyId = randomUUID();
  const agentId = randomUUID();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-deferred-wake-terminal-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, {
      runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" },
    });
  }, 20_000);

  beforeEach(async () => {
    await db.insert(companies).values({
      id: companyId,
      name: "Terminal Wake Test Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Worker Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true } },
      permissions: {},
    });
  });

  afterEach(async () => {
    await db.delete(agentWakeupRequests);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function deferredWake(issueId: string, extraPayload: Record<string, unknown> = {}) {
    return {
      id: randomUUID(),
      companyId,
      agentId,
      source: "automation",
      reason: "issue_commented",
      payload: { issueId, ...extraPayload },
      status: "deferred_issue_execution" as const,
      requestedByActorType: "user",
      requestedByActorId: "test-user",
    };
  }

  describe("Item 1: Transitioning issue to done/cancelled cancels deferred executions", () => {
    it("cancels all deferred executions when issue is updated to cancelled", async () => {
      const issueId = randomUUID();
      const otherIssueId = randomUUID();

      await db.insert(issues).values([
        {
          id: issueId,
          companyId,
          title: "Issue to be cancelled",
          status: "in_progress",
          priority: "high",
          assigneeAgentId: agentId,
        },
        {
          id: otherIssueId,
          companyId,
          title: "Other active issue",
          status: "in_progress",
          priority: "medium",
          assigneeAgentId: agentId,
        },
      ]);

      const wake1 = deferredWake(issueId);
      const wake2 = deferredWake(issueId, { queuedCommentInterrupt: { actorId: "board-user" } });
      const otherWake = deferredWake(otherIssueId);

      await db.insert(agentWakeupRequests).values([wake1, wake2, otherWake]);

      // Transition issue to cancelled via issueService.update
      await issueService(db).update(issueId, { status: "cancelled" });

      const issueWakes = await db
        .select()
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, companyId),
            eq(agentWakeupRequests.agentId, agentId),
          ),
        );

      const cancelledWakes = issueWakes.filter((w) => w.id === wake1.id || w.id === wake2.id);
      expect(cancelledWakes).toHaveLength(2);
      for (const w of cancelledWakes) {
        expect(w.status).toBe("cancelled");
        expect(w.error).toBe("issue_closed");
        expect(w.finishedAt).not.toBeNull();
      }

      const untouchedWake = issueWakes.find((w) => w.id === otherWake.id);
      expect(untouchedWake?.status).toBe("deferred_issue_execution");
      expect(untouchedWake?.error).toBeNull();
    });

    it("cancels all deferred executions when issue is updated to done", async () => {
      const issueId = randomUUID();

      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Issue to be completed",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
      });

      const wake = deferredWake(issueId);
      await db.insert(agentWakeupRequests).values(wake);

      await issueService(db).update(issueId, { status: "done" });

      const [updatedWake] = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wake.id));

      expect(updatedWake?.status).toBe("cancelled");
      expect(updatedWake?.error).toBe("issue_closed");
      expect(updatedWake?.finishedAt).not.toBeNull();
    });

    it("cancels deferred executions when done includes a status decision id", async () => {
      const issueId = randomUUID();

      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Decision-backed issue to be completed",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
      });

      const wake = deferredWake(issueId);
      await db.insert(agentWakeupRequests).values(wake);

      await issueService(db).update(issueId, {
        status: "done",
        lastStatusDecisionId: randomUUID(),
      });

      const [updatedWake] = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wake.id));

      expect(updatedWake?.status).toBe("cancelled");
      expect(updatedWake?.error).toBe("issue_closed");
      expect(updatedWake?.finishedAt).not.toBeNull();
    });

    it("cancelDeferredExecutionsForTerminalIssue can be called directly", async () => {
      const issueId = randomUUID();

      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Direct cancel test",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
      });

      const wake1 = deferredWake(issueId);
      const wake2 = deferredWake(issueId);
      await db.insert(agentWakeupRequests).values([wake1, wake2]);

      const cancelledCount = await issueService(db).cancelDeferredExecutionsForTerminalIssue(
        issueId,
        companyId,
      );

      expect(cancelledCount).toBe(2);

      const rows = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, companyId));

      expect(rows.every((r) => r.status === "cancelled" && r.error === "issue_closed")).toBe(true);
    });
  });

  describe("Item 2: queued-comment-interrupt does not repeat infinitely on closed task", () => {
    it("skips once due to issue_state_guard_mismatch and closes the original deferred wake", async () => {
      const issueId = randomUUID();

      // Issue is already cancelled
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Closed task with interrupted queue",
        status: "cancelled",
        priority: "medium",
        assigneeAgentId: agentId,
      });

      const queueId = randomUUID();
      const deferredReceipt = {
        id: queueId,
        companyId,
        agentId,
        source: "on_demand",
        reason: "issue_commented",
        payload: {
          issueId,
          queuedCommentInterrupt: {
            actorId: "board-user",
            requestedAt: new Date().toISOString(),
          },
          _paperclipWakeContext: {
            issueId,
            wakeCommentIds: [randomUUID()],
          },
        },
        status: "deferred_issue_execution" as const,
        requestedByActorType: "user",
        requestedByActorId: "board-user",
        idempotencyKey: `chat-inbound-test:${queueId}`, // not chat-inbound: so resumeSavedLegacyComments doesn't skip early
      };

      await db.insert(agentWakeupRequests).values(deferredReceipt);

      // First run: resumeQueuedCommentInterrupt
      await heartbeat.resumeQueuedCommentInterrupt(companyId, queueId);

      // Verify the skipped receipt was created
      const skippedWakes = await db
        .select()
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, companyId),
            eq(agentWakeupRequests.reason, "issue_state_guard_mismatch"),
          ),
        );

      expect(skippedWakes).toHaveLength(1);
      expect(skippedWakes[0]?.status).toBe("skipped");
      expect(skippedWakes[0]?.idempotencyKey).toBe(`queued-comment-interrupt:${queueId}`);

      // Verify the original deferred wake was cancelled
      const [sourceWake] = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, queueId));

      expect(sourceWake?.status).toBe("cancelled");
      expect(sourceWake?.error).toBe("issue_closed");
      expect(sourceWake?.finishedAt).not.toBeNull();

      // Second run: repeating the interrupt call should be a no-op
      await heartbeat.resumeQueuedCommentInterrupt(companyId, queueId);

      const allWakesAfterSecondRun = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, companyId));

      // Exactly 2 rows: original cancelled wake + exactly 1 skipped wake
      expect(allWakesAfterSecondRun).toHaveLength(2);
      const skippedAfterSecondRun = allWakesAfterSecondRun.filter(
        (w) => w.reason === "issue_state_guard_mismatch",
      );
      expect(skippedAfterSecondRun).toHaveLength(1);
    });
  });
});
