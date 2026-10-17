// myrmidon(REQUEUE-HOLD): a task an actor returned to the ready queue keeps
// the status that actor set — the recovery records its hold, never `blocked`.
//
// The seeded state is the OPE-6324 incident: a ticket with a stopped run and
// an active reconciliation action that a lead re-queued with a PATCH to
// `todo`. Every re-queue was reverted to `blocked` (22:10:13 and 23:05:20 UTC)
// by `execution-recovery`, with `blockedBy` empty and no run — the task could
// not be put back to work at all. The closure now leaves the status alone and
// keeps the settled "do not replay" hold, so nothing replays until an
// explicitly authorized wake or a person's unblock lifts it (HOLD-READY).
// See requeued.ts.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { getExecutionBlocker } from "../../services/execution-blocker.js";
import { settleUnrecoverableExecutions } from "../../services/execution-recovery-resolution.js";
import { LEGACY_RECOVERY_CAUSE } from "../../services/legacy-execution-recovery.js";
import { isReadyQueueStatus, READY_QUEUE_STATUSES, REQUEUED_HOLD_NOTE } from "./requeued.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const TEST_TIMEOUT_MS = 150_000;

describe("isReadyQueueStatus", () => {
  it("covers the statuses a task waits in, and nothing else", () => {
    expect(READY_QUEUE_STATUSES).toEqual(["backlog", "todo"]);
    for (const status of READY_QUEUE_STATUSES) expect(isReadyQueueStatus(status)).toBe(true);
    for (const status of ["in_progress", "in_review", "blocked", "done", "cancelled"]) {
      expect(isReadyQueueStatus(status)).toBe(false);
    }
  });
});

describeEmbeddedPostgres("a re-queued task keeps its status (OPE-6954)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-requeued-hold-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(status: string) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "user-a",
      requireBoardApprovalForNewAgents: false,
    });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-a",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    const [issue] = await db
      .insert(issues)
      .values({ companyId, title: "task", status, priority: "high", assigneeAgentId: agentId })
      .returning();
    const issueId = issue!.id;
    // The run the recovery is settling: stopped, and still named by the task.
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        status: "cancelled",
        finishedAt: new Date(),
        contextSnapshot: { issueId, taskKey: issueId },
      })
      .returning();
    await db
      .update(issues)
      .set({ executionRunId: run!.id, checkoutRunId: run!.id })
      .where(eq(issues.id, issueId));
    const [action] = await db
      .insert(issueRecoveryActions)
      .values({
        companyId,
        sourceIssueId: issueId,
        kind: "active_run_watchdog",
        ownerType: "board",
        returnOwnerAgentId: agentId,
        cause: LEGACY_RECOVERY_CAUSE,
        fingerprint: `legacy-execution:${run!.id}`,
        evidence: { runId: run!.id },
        nextAction: "Reconcile stopped work",
      })
      .returning();
    return { companyId, agentId, issueId, runId: run!.id, actionId: action!.id };
  }

  async function issueById(issueId: string) {
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    return issue!;
  }

  async function actionById(actionId: string) {
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, actionId));
    return action!;
  }

  it("reproduces OPE-6324: `todo` stays `todo`, the do-not-replay hold is recorded", async () => {
    const fixture = await seed("todo");

    await settleUnrecoverableExecutions(db);

    // The status the lead set is not overwritten; the stopped execution's
    // pointers are released like the `blocked` projection used to do it.
    const issue = await issueById(fixture.issueId);
    expect(issue.status).toBe("todo");
    expect(issue.executionRunId).toBeNull();
    expect(issue.checkoutRunId).toBeNull();

    // The closure is reported as what it is, not as a block.
    const action = await actionById(fixture.actionId);
    expect(action).toMatchObject({ status: "resolved", outcome: "cancelled" });
    expect(action.nextAction).toBe(REQUEUED_HOLD_NOTE);
    expect(action.resolutionNote).toBe(REQUEUED_HOLD_NOTE);

    // Nothing replays: the settled hold is still there, so the task is not
    // reported as ready and no wake can start a run from the failure.
    expect(await getExecutionBlocker(db, fixture.companyId, fixture.issueId)).not.toBeNull();
    expect(action.evidence.automaticRecovery).toMatchObject({
      policy: "preserve_without_replay_v1",
      replay: "blocked",
      runId: fixture.runId,
    });

    const settledActivity = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityId, fixture.issueId),
          eq(activityLog.action, "issue.execution_recovery_settled"),
        ),
      );
    expect(settledActivity.length).toBeGreaterThan(0);
    expect(settledActivity.map((entry) => entry.details?.outcome)).toContain("cancelled");
  }, TEST_TIMEOUT_MS);

  it("a queued `backlog` task keeps its status too", async () => {
    const fixture = await seed("backlog");

    await settleUnrecoverableExecutions(db);

    expect((await issueById(fixture.issueId)).status).toBe("backlog");
    expect(await actionById(fixture.actionId)).toMatchObject({ status: "resolved", outcome: "cancelled" });
  }, TEST_TIMEOUT_MS);

  it("a task that is being worked on still takes the vendor's `blocked` projection", async () => {
    const fixture = await seed("in_progress");

    await settleUnrecoverableExecutions(db);

    const issue = await issueById(fixture.issueId);
    expect(issue.status).toBe("blocked");
    expect(issue.executionRunId).toBeNull();
    expect(await actionById(fixture.actionId)).toMatchObject({ status: "resolved", outcome: "blocked" });
  }, TEST_TIMEOUT_MS);
});