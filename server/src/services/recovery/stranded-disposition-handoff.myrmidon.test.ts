// myrmidon(OPE-12887): BLOCKED-LOOP end-to-end proof. A run ends without a
// final status and the successful-run auto-policy escalates the issue. Two
// halves must hold together, not just in isolation:
//  1. attempts exhausted -> disposition_blocked handoff: the issue goes
//     `blocked`, OWNED by the nearest lead with the executor's stale
//     assignment released, and the lead's checkout (the act of taking the
//     handoff) succeeds without the 409 "another agent owns" deadlock.
//  2. attempts remain -> one explicit continuation wake to the executor
//     with the fresh-directive context, not a handoff.
// The escalation is driven through the real recovery service entry point
// (`escalateStrandedAssignedIssue`), so the disposition patch built by
// `buildStrandedDispositionBlockedPatch` demonstrably flows through
// recovery -> row -> checkout, instead of the test hand-seeding a blocked
// row the way the checkout unit tests do.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { issueService } from "../../services/issues.js";
import { recoveryService } from "./service.js";
import { STRANDED_AUTO_POLICY_RETRY_SOURCE } from "../../myrmidon/stranded-autopolicy.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres(
  "recovery disposition handoff -> lead checkout (OPE-12887 BLOCKED-LOOP, end to end)",
  () => {
    let db!: ReturnType<typeof createDb>;
    let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
    const originalAutoPolicyEnabled = process.env.MYRMIDON_STRANDED_AUTOPOLICY_ENABLED;
    const originalRetriesPerDay = process.env.MYRMIDON_STRANDED_AUTO_RETRIES_PER_DAY;

    beforeAll(async () => {
      process.env.MYRMIDON_STRANDED_AUTOPOLICY_ENABLED = "true";
      process.env.MYRMIDON_STRANDED_AUTO_RETRIES_PER_DAY = "2";
      tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-stranded-disposition-handoff-");
      db = createDb(tempDb.connectionString);
    }, 60_000);

    afterAll(async () => {
      await tempDb?.cleanup();
      if (originalAutoPolicyEnabled === undefined) delete process.env.MYRMIDON_STRANDED_AUTOPOLICY_ENABLED;
      else process.env.MYRMIDON_STRANDED_AUTOPOLICY_ENABLED = originalAutoPolicyEnabled;
      if (originalRetriesPerDay === undefined) delete process.env.MYRMIDON_STRANDED_AUTO_RETRIES_PER_DAY;
      else process.env.MYRMIDON_STRANDED_AUTO_RETRIES_PER_DAY = originalRetriesPerDay;
    });

    /**
     * Realistic stranded scene: an engineer has been working on an issue that
     * carries an execution policy (its own workflow — the reason recovery must
     * hand off instead of taking over), its latest run succeeded without a
     * final disposition, and the agent sits under a lead so the disposition
     * owner resolution finds one. `attemptsInWindow` is driven by real retry
     * runs seeded through the same contextSnapshot filter the counter reads.
     */
    async function seed(input: { attemptsInWindow?: number } = {}) {
      const companyId = randomUUID();
      const executorAgentId = randomUUID();
      const leadAgentId = randomUUID();
      const issueId = randomUUID();
      const issuePrefix = `H${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
      const now = new Date();

      await db.insert(companies).values({
        id: companyId,
        name: "Myrmidon",
        issuePrefix,
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(agents).values([
        {
          id: executorAgentId,
          companyId,
          name: "Executor",
          role: "engineer",
          status: "idle",
          adapterType: "codex_local",
          adapterConfig: {},
          runtimeConfig: {},
          permissions: {},
        },
        {
          id: leadAgentId,
          companyId,
          name: "Lead",
          role: "lead",
          status: "idle",
          adapterType: "hermes_gateway",
          adapterConfig: {},
          runtimeConfig: {},
          permissions: {},
        },
      ]);
      await db.update(agents)
        .set({ reportsTo: leadAgentId })
        .where(eq(agents.id, executorAgentId));

      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Run ended without a final status",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: executorAgentId,
        assigneeUserId: null,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [
            {
              type: "approval",
              approvalsNeeded: 1,
              participants: [{ type: "agent", agentId: leadAgentId }],
            },
          ],
        },
        executionState: null,
      });

      // The run whose missing disposition is being recovered. Not the
      // execution lock: the run is terminal, so checkout's terminal-run
      // guards leave it alone.
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId: executorAgentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "succeeded",
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_continuation_needed",
        },
        startedAt: new Date(now.getTime() - 120_000),
        finishedAt: now,
        updatedAt: now,
      });

      // Real retry-run rows inside the 24h window: the same filter
      // (`contextSnapshot->>'source' = STRANDED_AUTO_POLICY_RETRY_SOURCE`)
      // `countStrandedAutoPolicyAttemptsInWindow` counts, so "attempts
      // exhausted" is produced the way production produces it.
      for (let i = 0; i < (input.attemptsInWindow ?? 0); i += 1) {
        const retryRunId = randomUUID();
        const createdAt = new Date(now.getTime() - (30 + i) * 60_000);
        await db.insert(heartbeatRuns).values({
          id: retryRunId,
          companyId,
          agentId: executorAgentId,
          invocationSource: "automation",
          triggerDetail: "system",
          status: "succeeded",
          contextSnapshot: {
            issueId,
            source: STRANDED_AUTO_POLICY_RETRY_SOURCE,
            wakeReason: "issue_continuation_needed",
          },
          startedAt: new Date(createdAt.getTime() - 30_000),
          finishedAt: createdAt,
          createdAt,
          updatedAt: createdAt,
        });
      }

      return { companyId, executorAgentId, leadAgentId, issueId, runId };
    }

    function createService() {
      const wakes: Array<{ agentId: string; opts: Record<string, unknown> | undefined }> = [];
      const service = recoveryService(db, {
        enqueueWakeup: async (agentId, opts) => {
          wakes.push({ agentId, opts: opts as Record<string, unknown> | undefined });
          return {
            id: randomUUID(),
            status: "queued",
          } as unknown as typeof heartbeatRuns.$inferSelect;
        },
      });
      return { service, wakes };
    }

    async function escalate(
      service: ReturnType<typeof recoveryService>,
      seeded: Awaited<ReturnType<typeof seed>>,
    ) {
      const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId));
      return service.escalateStrandedAssignedIssue({
        issue: issue!,
        previousStatus: "in_progress",
        latestRun: run!,
        recoveryCause: "successful_run_missing_state",
      });
    }

    async function readIssue(issueId: string) {
      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      return issue!;
    }

    it("exhausted attempts: recovery hands the issue to the lead unassigned, and the lead's checkout succeeds without 409", async () => {
      const seeded = await seed({ attemptsInWindow: 2 });
      const { service, wakes } = createService();

      const escalated = await escalate(service, seeded);
      expect(escalated).toBeTruthy();

      // The issue is now blocked and owned by the lead with complete
      // metadata — the exact shape `buildStrandedDispositionBlockedPatch`
      // builds, persisted through the recovery service transaction.
      const blocked = await readIssue(seeded.issueId);
      expect(blocked.status).toBe("blocked");
      expect(blocked.assigneeAgentId).toBeNull();
      expect(blocked.assigneeUserId).toBeNull();
      expect(blocked.blockerMetadata).toMatchObject({
        blockReason: "recovery",
        owner: { agentId: seeded.leadAgentId },
        escalationPolicy: "stranded_disposition_chain_v1",
      });
      expect(blocked.unblockDescriptor).toMatchObject({
        owner: { agentId: seeded.leadAgentId },
      });
      expect(blocked.blockedTransitionAt).toBeInstanceOf(Date);
      // myrmidon(OPE-12887): the recovery service path only queues the owner
      // wake (`enqueueWakeup`); `blocked_owner_notified_at` is stamped later
      // by the delivery flow (`deliverAgentUnblockNotification` in the issues
      // route), so it must still be null here — a Date here would mean the
      // handoff claimed a delivery the wake queue has not confirmed.
      expect(blocked.blockedOwnerNotifiedAt).toBeNull();
      expect(blocked.executionState).toBeNull();
      expect(blocked.executionPolicy).not.toBeNull();

      // Exactly one wake — to the lead, not the executor.
      expect(wakes).toHaveLength(1);
      expect(wakes[0]!.agentId).toBe(seeded.leadAgentId);
      expect(wakes[0]!.opts?.reason).toBe("issue_unblock_requested");

      // The escalation posted the system disposition comment.
      const comments = await db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, seeded.issueId));
      expect(comments.some((row) => row.body.includes("could not get a final status from the assignee"))).toBe(true);

      // The escalation logged the disposition_blocked action with the owner.
      const actions = await db
        .select({ action: activityLog.action, details: activityLog.details })
        .from(activityLog)
        .where(eq(activityLog.entityId, seeded.issueId));
      expect(
        actions.some((row) => row.action === "issue.stranded_autopolicy_disposition_blocked"),
      ).toBe(true);
      expect(
        actions.some(
          (row) =>
            row.action === "issue.stranded_autopolicy_disposition_blocked" &&
            (row.details as { ownerAgentId?: string } | null)?.ownerAgentId === seeded.leadAgentId,
        ),
      ).toBe(true);
    });

    it("checkout by the blocker owner completes the handoff in_progress with recovery metadata cleared", async () => {
      const seeded = await seed({ attemptsInWindow: 2 });
      const { service } = createService();
      await escalate(service, seeded);

      // The lead takes the handoff through the normal checkout API. This is
      // the exact call that used to 409 ("another agent owns") when the
      // handoff left the executor assigned: the stale assignment must not
      // hold the issue hostage, and the takeover must consume the blocked
      // state instead of carrying recovery metadata into in_progress.
      // checkoutRunId is a real FK into heartbeat_runs, so the lead's run row
      // must exist before checkout (same seeding as the checkout unit test).
      const leadRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: leadRunId,
        companyId: seeded.companyId,
        agentId: seeded.leadAgentId,
        status: "running",
        invocationSource: "manual",
      });
      const claimed = await issueService(db).checkout(seeded.issueId, seeded.leadAgentId, ["blocked"], leadRunId);

      expect(claimed.status).toBe("in_progress");
      expect(claimed.assigneeAgentId).toBe(seeded.leadAgentId);
      expect(claimed.blockerMetadata).toBeNull();
      expect(claimed.unblockDescriptor).toBeNull();
      expect(claimed.blockedTransitionAt).toBeNull();
      expect(claimed.blockedOwnerNotifiedAt).toBeNull();
      expect(claimed.checkoutRunId).toBe(leadRunId);
      expect(claimed.executionRunId).toBe(leadRunId);
    });

    it("attempts remain: the executor gets one explicit continuation with fresh-directive context, no handoff", async () => {
      await underTwoAttempts();
    });

    async function underTwoAttempts() {
      const seeded = await seed({ attemptsInWindow: 1 });
      const { service, wakes } = createService();

      const escalated = await escalate(service, seeded);
      expect(escalated).toBeTruthy();

      // No blocked transition at all.
      const untouched = await readIssue(seeded.issueId);
      expect(untouched.status).toBe("in_progress");
      expect(untouched.assigneeAgentId).toBe(seeded.executorAgentId);
      expect(untouched.blockerMetadata).toBeNull();
      expect(untouched.unblockDescriptor).toBeNull();

      // One continuation wake to the executor (retry branch), not the lead.
      expect(wakes).toHaveLength(1);
      expect(wakes[0]!.agentId).toBe(seeded.executorAgentId);
      expect(wakes[0]!.opts?.reason).toBe("issue_continuation_needed");
      const context = wakes[0]!.opts?.contextSnapshot as Record<string, unknown> | undefined;
      expect(context?.source).toBe(STRANDED_AUTO_POLICY_RETRY_SOURCE);
      expect(context?.retryReason).toBe("issue_continuation_needed");
      const payload = wakes[0]!.opts?.payload as Record<string, unknown> | undefined;
      expect(payload?.issueId).toBe(seeded.issueId);
      // Missing-disposition cause is named in the wake payload.
      expect(JSON.stringify(payload)).toContain("successful_run_missing_state");

      // No disposition comment, no blocked state: the executor keeps the task.
      const comments = await db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, seeded.issueId));
      expect(comments).toHaveLength(0);
      expect(
        (await db.select().from(activityLog).where(eq(activityLog.entityId, seeded.issueId)))
          .some((row) => (row.details as { action?: string } | null)?.action === "issue.stranded_autopolicy_disposition_blocked"),
      ).toBe(false);
    }
  },
);
