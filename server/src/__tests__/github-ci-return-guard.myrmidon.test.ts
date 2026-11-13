// myrmidon(EMPTY-RUNS-3): a CI delivery of a pull request is handled by the
// final result of the head.
//
// Pins, through the real event service with the check runs of the head handed
// in (no network):
//   - one finished job is not a finished CI: the monitor of the task stays
//     armed, nobody is woken, `lastCompletedCi` is not written;
//   - the final result of the current head (`CI result`) disarms the monitor
//     and wakes the assignee exactly once; the same result delivered again
//     wakes nobody; a result of an older head decides nothing;
//   - a pull request without the aggregate check is finished when GitHub shows
//     every check finished;
//   - a job that starts after the result of the head does not reopen it, the
//     final check does;
//   - a task in review goes back to its executor on the final failure, once,
//     with the failed checks named; a head whose `main-green` is red is held
//     (one note, one `ci_infra_retry_needed` row, no wake) and returned when
//     `main-green` passes again; a head on which only the aggregate failed is
//     held as infrastructure;
//   - check runs the board cannot read and the guard switched off;
//   - every wake of a delivery is sent after the delivery has committed.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  connectionEventDeliveries,
  connectionGrants,
  createDb,
  externalObjects,
  issueComments,
  issueWorkProducts,
  issues,
  toolApplications,
  toolConnections,
} from "@myrmidon/db";
import { and, eq } from "drizzle-orm";
import { githubConnectionEventService } from "../services/github-connection-events.js";
import type { PaperclipCloudConnector } from "../services/paperclip-cloud-connector.js";
import type { CiReturnFacts } from "../myrmidon/review-return-guard/ci-failure-return.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const REPO = "paperclipai/paperclip";
const HEAD = "a".repeat(40);
const OLDER_HEAD = "b".repeat(40);
const RUN_URL = "https://github.com/paperclipai/paperclip/actions/runs/456";

/** The check runs of a head whose aggregate `CI result` finished red with these failed checks. */
function redHead(failed: string[]): CiReturnFacts {
  return { state: "ok", failed, finished: true, hasFinalCheck: true, finalCheckConclusion: "failure" };
}

const GREEN_HEAD: CiReturnFacts = { state: "ok", failed: [], finished: true, hasFinalCheck: true, finalCheckConclusion: "success" };

describeEmbeddedPostgres.sequential("CI deliveries by the final result of the head (EMPTY-RUNS-3)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-ci-return-guard-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(connectionEventDeliveries);
    await db.delete(issueWorkProducts);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(externalObjects);
    await db.delete(connectionGrants);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  type Seeded = { companyId: string; executorId: string; reviewerId: string; issueId: string; grantId: string };

  /**
   * A task with an open pull request, an armed monitor and a GitHub connection
   * that delivers its events. By default the task is in a pending review stage
   * (assignee: the reviewer); `executing` leaves it with its executor, in
   * `status` (default `in_progress`); `unmonitored` arms no monitor.
   */
  async function seedTask(
    overrides: { executing?: boolean; status?: string; unmonitored?: boolean; productHeadSha?: string } = {},
  ): Promise<Seeded> {
    const companyId = randomUUID();
    const executorId = randomUUID();
    const reviewerId = randomUUID();
    const issueId = randomUUID();
    const connectionId = randomUUID();
    const grantId = randomUUID();
    const applicationId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: "GCR" });
    await db.insert(agents).values({ id: executorId, companyId, name: "worker", role: "engineer" });
    await db.insert(agents).values({ id: reviewerId, companyId, name: "reviewer", role: "engineer" });
    await db.insert(issues).values({
      id: issueId, companyId, title: "PR task", workMode: "standard",
      monitorNextCheckAt: overrides.unmonitored ? null : new Date("2026-09-04T12:10:00.000Z"),
      ...(overrides.executing
        ? { status: overrides.status ?? "in_progress", assigneeAgentId: executorId }
        : {
            status: "in_review",
            assigneeAgentId: reviewerId,
            executionState: {
              status: "pending", currentStageId: randomUUID(), currentStageIndex: 0,
              currentStageType: "review", currentParticipant: { type: "agent", agentId: reviewerId },
              returnAssignee: { type: "agent", agentId: executorId }, completedStageIds: [],
              lastDecisionId: null, lastDecisionOutcome: null,
            },
          }),
    });
    await db.insert(issueWorkProducts).values({
      companyId, issueId, type: "pull_request", provider: "github", externalId: `${REPO}#pull/123`, title: "PR #123", status: "open",
      metadata: { repository: REPO, number: 123, ...(overrides.productHeadSha ? { headSha: overrides.productHeadSha } : {}) },
    });
    await db.insert(toolApplications).values({ id: applicationId, companyId, applicationKey: `github-${randomUUID()}`, name: "GitHub", type: "mcp_server", status: "active" });
    await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "GitHub", uid: `github-${randomUUID()}`, transport: "mcp_remote", authKind: "oauth", credentialPolicy: "per_user", status: "active", enabled: true, config: { sourceTemplateKey: "github", oauth: { connectorProfile: "github.code" } }, transportConfig: {} });
    await db.insert(connectionGrants).values({ id: grantId, companyId, connectionId, kind: "user", subjectUserId: `github-owner-${randomUUID()}`, status: "active", isDefault: false, providerTenant: { oauth: { strategy: "paperclip_cloud_connector", accessTokenExpiresAt: null }, github: { userId: "42", login: "octocat", installationCount: 1, repositoryCount: 1, repositorySelection: "selected", installationIds: ["101"], installationOwnerLogins: ["paperclipai"], repositories: [], webhookHealth: "pending" } } });
    return { companyId, executorId, reviewerId, issueId, grantId };
  }

  /** One CI delivery of the pull request: `conclusion` null is a job that has just started. */
  function ciEvent(
    seeded: Seeded,
    event: "check_run" | "check_suite" | "workflow_run",
    conclusion: string | null,
    checkName?: string,
    headSha: string = HEAD,
  ) {
    return {
      id: `ci-delivery-${randomUUID()}`, provider: "github" as const, event, action: conclusion ? "completed" : "created", installationId: "101", repositoryId: "99",
      createdAt: "2026-09-04T12:00:00.000Z", bindingIds: [`${seeded.grantId}_101`],
      payload: {
        repository: REPO, pullRequest: { number: 123 }, number: 123,
        status: conclusion ? "completed" : "in_progress", conclusion,
        headSha, runId: "456", htmlUrl: RUN_URL, checkSuiteId: "789",
        ...(checkName ? { checkName } : {}),
      },
    };
  }

  type Delivery = ReturnType<typeof ciEvent>;

  /**
   * The event service; `deliver` leases one batch of events. `readHead` is the
   * reader of the check runs of the head; without it the service is built the
   * old way (every completed delivery is a finished CI).
   */
  function startService(options: {
    readHead?: () => CiReturnFacts;
    env?: NodeJS.ProcessEnv;
    onWake?: () => Promise<void>;
    /** Postgres rolls the first transaction of a delivery back for a deadlock after all its writes. */
    deadlockFirstTransaction?: boolean;
  } = {}) {
    let batch: Delivery[] = [];
    let currentTime = new Date("2026-09-04T12:00:05.000Z");
    const connector = {
      getCapabilities: vi.fn(async () => ["github.code"] as const), startAuthorization: vi.fn(), claim: vi.fn(), refresh: vi.fn(), revoke: vi.fn(),
      setWebhookBinding: vi.fn(async () => undefined),
      leaseEvents: vi.fn(async () => ({ leaseId: randomUUID(), events: batch })),
      acknowledgeEvents: vi.fn(async () => batch.length),
    } as unknown as PaperclipCloudConnector;
    const wakeup = vi.fn(async () => {
      await options.onWake?.();
      return undefined;
    });
    const readHead = options.readHead;
    const resolveCiReturnFacts = vi.fn(async () => (readHead ? readHead() : GREEN_HEAD));
    let rolledBack = false;
    // The real transaction runs and is then aborted with the error Postgres gives
    // for a deadlock (40P01): everything it wrote is rolled back, as on the board.
    const serviceDb = options.deadlockFirstTransaction
      ? new Proxy(db, {
          get(target, property, receiver) {
            if (property !== "transaction") return Reflect.get(target, property, receiver);
            return (callback: (tx: unknown) => Promise<unknown>, config?: unknown) =>
              target.transaction(async (tx) => {
                const result = await callback(tx);
                if (!rolledBack) {
                  rolledBack = true;
                  throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
                }
                return result;
              }, config as never);
          },
        })
      : db;
    const service = githubConnectionEventService(serviceDb, {
      connector,
      assignmentWakeup: wakeup,
      now: () => currentTime,
      ...(readHead ? { resolveCiReturnFacts } : {}),
      ...(options.env ? { env: options.env } : {}),
    });
    return {
      wakeup,
      resolveCiReturnFacts,
      async deliver(events: Delivery[]) {
        batch = events;
        currentTime = new Date(currentTime.getTime() + 5_000);
        return service.pollOnce();
      },
    };
  }

  async function taskOf(seeded: Seeded) {
    const [task] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    return task!;
  }

  async function commentsOf(seeded: Seeded) {
    return db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId));
  }

  async function activityOf(seeded: Seeded, action: string) {
    return db.select().from(activityLog).where(and(eq(activityLog.entityId, seeded.issueId), eq(activityLog.action, action)));
  }

  async function productMetadataOf(seeded: Seeded) {
    const [product] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, seeded.issueId));
    return (product?.metadata ?? {}) as Record<string, unknown>;
  }

  describe("the monitor and the wake of a task that waits for CI", () => {
    it("leaves the task alone on finished jobs and wakes its assignee once on the final result", async () => {
      const seeded = await seedTask({ executing: true });
      const service = startService({ readHead: () => GREEN_HEAD });

      // Lanes that finish, green or red, and a lane delivered without a name.
      await expect(service.deliver([
        ciEvent(seeded, "check_run", "success", "typecheck + build"),
        ciEvent(seeded, "check_run", "failure", "tests (server 3/6)"),
        ciEvent(seeded, "check_run", "success"),
      ])).resolves.toMatchObject({ processed: 3, failed: 0 });

      let task = await taskOf(seeded);
      expect(task.monitorNextCheckAt).not.toBeNull();
      expect(service.wakeup).not.toHaveBeenCalled();
      expect(service.resolveCiReturnFacts).not.toHaveBeenCalled();
      expect(await productMetadataOf(seeded)).not.toHaveProperty("lastCompletedCi");

      // The final check of the head: the monitor is disarmed and the assignee woken.
      await expect(service.deliver([ciEvent(seeded, "check_run", "success", "CI result")])).resolves.toMatchObject({ processed: 1, failed: 0 });

      task = await taskOf(seeded);
      expect(task).toMatchObject({ status: "in_progress", assigneeAgentId: seeded.executorId });
      expect(task.monitorNextCheckAt).toBeNull();
      expect(await productMetadataOf(seeded)).toMatchObject({
        activeCi: null,
        lastCompletedCi: { headSha: HEAD, conclusion: "success" },
        ciFinalCheckSeen: true,
      });
      expect(service.wakeup).toHaveBeenCalledTimes(1);
      expect(service.wakeup).toHaveBeenCalledWith(seeded.executorId, expect.objectContaining({
        reason: "ci_completed",
        payload: expect.objectContaining({ conclusion: "success", headSha: HEAD, pullRequestNumber: 123 }),
        idempotencyKey: `ci_completed:${REPO}:123:${HEAD}`,
      }));

      // The same result delivered again, and the run and the suite of the same
      // workflow that end after their last job: nobody is woken a second time.
      await expect(service.deliver([
        ciEvent(seeded, "check_run", "success", "CI result"),
        ciEvent(seeded, "workflow_run", "success"),
        ciEvent(seeded, "check_suite", "success"),
      ])).resolves.toMatchObject({ processed: 3, failed: 0 });
      expect(service.wakeup).toHaveBeenCalledTimes(1);
      // Once the pull request is known to have the final check, a finished run is not looked up on GitHub.
      expect(service.resolveCiReturnFacts).not.toHaveBeenCalled();
    });

    it("wakes the assignee for a failed final result too, and again when a re-run turns it green", async () => {
      const seeded = await seedTask({ executing: true });
      const service = startService({ readHead: () => GREEN_HEAD });

      await expect(service.deliver([ciEvent(seeded, "check_run", "failure", "CI result")])).resolves.toMatchObject({ processed: 1, failed: 0 });

      // The task is not in review: nothing to return, the assignee hears about the result.
      expect(await taskOf(seeded)).toMatchObject({ status: "in_progress", assigneeAgentId: seeded.executorId, monitorNextCheckAt: null });
      expect(await commentsOf(seeded)).toHaveLength(0);
      expect(service.wakeup).toHaveBeenCalledTimes(1);
      expect(service.wakeup).toHaveBeenLastCalledWith(seeded.executorId, expect.objectContaining({
        reason: "ci_completed",
        payload: expect.objectContaining({ conclusion: "failure" }),
      }));

      await expect(service.deliver([ciEvent(seeded, "check_run", "success", "CI result")])).resolves.toMatchObject({ processed: 1, failed: 0 });
      expect(service.wakeup).toHaveBeenCalledTimes(2);
      expect(service.wakeup).toHaveBeenLastCalledWith(seeded.executorId, expect.objectContaining({
        payload: expect.objectContaining({ conclusion: "success" }),
      }));
      expect(await productMetadataOf(seeded)).toMatchObject({ lastCompletedCi: { headSha: HEAD, conclusion: "success" } });
    });

    it("does not take the mark the old handling left for a finished job for the result of the head", async () => {
      const seeded = await seedTask({ executing: true });
      // Written before the change by any job of this head that ended green.
      await db.update(issueWorkProducts).set({
        metadata: { repository: REPO, number: 123, activeCi: null, lastCompletedCi: { headSha: HEAD, conclusion: "success", runId: "1" } },
      }).where(eq(issueWorkProducts.issueId, seeded.issueId));
      const service = startService({ readHead: () => GREEN_HEAD });

      await expect(service.deliver([ciEvent(seeded, "check_run", "success", "CI result")])).resolves.toMatchObject({ processed: 1, failed: 0 });

      expect((await taskOf(seeded)).monitorNextCheckAt).toBeNull();
      expect(await productMetadataOf(seeded)).toMatchObject({ lastCompletedCi: { headSha: HEAD, conclusion: "success", final: true } });
      expect(service.wakeup).toHaveBeenCalledTimes(1);
    });

    it("does not take a cancelled final check, or the result of an older head, for the result", async () => {
      const seeded = await seedTask({ executing: true, productHeadSha: HEAD });
      const service = startService({ readHead: () => GREEN_HEAD });

      await expect(service.deliver([
        // The run was superseded by a newer one.
        ciEvent(seeded, "check_run", "cancelled", "CI result"),
        // A late result of the head before the last push.
        ciEvent(seeded, "check_run", "failure", "CI result", OLDER_HEAD),
      ])).resolves.toMatchObject({ processed: 2, failed: 0 });

      expect((await taskOf(seeded)).monitorNextCheckAt).not.toBeNull();
      expect(service.wakeup).not.toHaveBeenCalled();
      expect(await productMetadataOf(seeded)).not.toHaveProperty("lastCompletedCi");
    });

    it("finishes the CI of a pull request without the aggregate check when GitHub shows every check finished", async () => {
      const seeded = await seedTask({ executing: true });
      let head: CiReturnFacts = { state: "ok", failed: [], finished: false, hasFinalCheck: false, finalCheckConclusion: null };
      const service = startService({ readHead: () => head });

      // The first workflow ends while another one is still running.
      await expect(service.deliver([ciEvent(seeded, "workflow_run", "success")])).resolves.toMatchObject({ processed: 1, failed: 0 });
      expect(service.resolveCiReturnFacts).toHaveBeenCalledTimes(1);
      expect(service.resolveCiReturnFacts).toHaveBeenCalledWith({ companyId: seeded.companyId, repository: REPO, pullRequestNumber: 123, headSha: HEAD });
      expect((await taskOf(seeded)).monitorNextCheckAt).not.toBeNull();
      expect(service.wakeup).not.toHaveBeenCalled();
      expect(await productMetadataOf(seeded)).not.toHaveProperty("lastCompletedCi");

      // The last workflow ends: every check of the head has finished, one of them red.
      head = { state: "ok", failed: ["build"], finished: true, hasFinalCheck: false, finalCheckConclusion: null };
      await expect(service.deliver([ciEvent(seeded, "workflow_run", "failure")])).resolves.toMatchObject({ processed: 1, failed: 0 });

      expect((await taskOf(seeded)).monitorNextCheckAt).toBeNull();
      expect(await productMetadataOf(seeded)).toMatchObject({ lastCompletedCi: { headSha: HEAD, conclusion: "failure" } });
      expect(service.wakeup).toHaveBeenCalledTimes(1);
      expect(service.wakeup).toHaveBeenCalledWith(seeded.executorId, expect.objectContaining({
        reason: "ci_completed",
        payload: expect.objectContaining({ conclusion: "failure" }),
      }));

      // The suite of the same run reports the same result: nobody is woken again.
      await expect(service.deliver([ciEvent(seeded, "check_suite", "failure")])).resolves.toMatchObject({ processed: 1, failed: 0 });
      expect(service.wakeup).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["a parked task without a monitor", "todo", true, false],
      ["a blocked task without a monitor", "blocked", true, false],
      ["a closed task", "done", false, false],
      ["a parked task whose agent armed a monitor", "todo", false, true],
    ])("records the result for %s and wakes only an agent that waits for it", async (_name, status, unmonitored, wakes) => {
      const seeded = await seedTask({ executing: true, status, unmonitored });
      const service = startService({ readHead: () => GREEN_HEAD });

      await expect(service.deliver([ciEvent(seeded, "check_run", "success", "CI result")])).resolves.toMatchObject({ processed: 1, failed: 0 });

      expect(await productMetadataOf(seeded)).toMatchObject({ lastCompletedCi: { headSha: HEAD, conclusion: "success" } });
      expect(await taskOf(seeded)).toMatchObject({ status, assigneeAgentId: seeded.executorId });
      expect(service.wakeup).toHaveBeenCalledTimes(wakes ? 1 : 0);
      if (!wakes && !unmonitored) expect((await taskOf(seeded)).monitorNextCheckAt).not.toBeNull();
    });

    it("keeps the result of the head when an auxiliary job starts after it; the final check reopens it", async () => {
      const seeded = await seedTask({ executing: true });
      const service = startService({ readHead: () => GREEN_HEAD });

      // Jobs start: the CI of the head is running.
      await expect(service.deliver([ciEvent(seeded, "check_run", null, "tests (affected)")])).resolves.toMatchObject({ processed: 1, failed: 0 });
      expect(await productMetadataOf(seeded)).toMatchObject({ activeCi: { headSha: HEAD, status: "in_progress" }, lastCompletedCi: null });

      await service.deliver([ciEvent(seeded, "check_run", "failure", "CI result")]);
      expect(await productMetadataOf(seeded)).toMatchObject({ activeCi: null, lastCompletedCi: { headSha: HEAD, conclusion: "failure" } });

      // The gate of the base branch is re-run on the same head, and ends: the result of the head stands.
      await service.deliver([ciEvent(seeded, "check_run", null, "main-green")]);
      await service.deliver([ciEvent(seeded, "check_run", "success", "main-green")]);
      expect(await productMetadataOf(seeded)).toMatchObject({ activeCi: null, lastCompletedCi: { headSha: HEAD, conclusion: "failure" } });

      // The aggregate itself is re-run: the head has no result until it ends.
      await service.deliver([ciEvent(seeded, "check_run", null, "CI result")]);
      expect(await productMetadataOf(seeded)).toMatchObject({ activeCi: { headSha: HEAD }, lastCompletedCi: null });
      expect(service.wakeup).toHaveBeenCalledTimes(1);
    });
  });

  describe("the return of a task from review", () => {
    it("keeps the task in review on a failed lane and returns it once on the final failure", async () => {
      const seeded = await seedTask();
      const service = startService({ readHead: () => redHead(["tests (server 3/6)", "CI result"]) });

      await expect(service.deliver([ciEvent(seeded, "check_run", "failure", "tests (server 3/6)")])).resolves.toMatchObject({ processed: 1, failed: 0 });

      let task = await taskOf(seeded);
      expect(task).toMatchObject({ status: "in_review", assigneeAgentId: seeded.reviewerId });
      expect(task.executionState).toMatchObject({ status: "pending" });
      expect(task.monitorNextCheckAt).not.toBeNull();
      expect(await commentsOf(seeded)).toHaveLength(0);
      expect(await activityOf(seeded, "issue.ci_failed")).toHaveLength(0);
      expect(service.wakeup).not.toHaveBeenCalled();
      // A named lane cannot finish the CI: not even a GitHub read is spent on it.
      expect(service.resolveCiReturnFacts).not.toHaveBeenCalled();

      // The aggregate check finished red with a real failure and a green base: the return.
      await expect(service.deliver([
        ciEvent(seeded, "check_run", "failure", "CI result"),
        ciEvent(seeded, "workflow_run", "failure"),
        ciEvent(seeded, "check_suite", "failure"),
      ])).resolves.toMatchObject({ processed: 3, failed: 0 });

      task = await taskOf(seeded);
      expect(task).toMatchObject({ status: "in_progress", assigneeAgentId: seeded.executorId, monitorNextCheckAt: null });
      expect(task.executionState).toMatchObject({ status: "changes_requested" });
      const comments = await commentsOf(seeded);
      expect(comments).toHaveLength(1);
      expect(comments[0]!.body).toContain("CI failure");
      expect(comments[0]!.body).toContain(HEAD);
      expect(comments[0]!.body).toContain(RUN_URL);
      expect(comments[0]!.body).toContain("Failed checks: tests (server 3/6), CI result.");
      const returns = await activityOf(seeded, "issue.ci_failed");
      expect(returns).toHaveLength(1);
      expect(returns[0]!.details).toMatchObject({ conclusion: "failure", headSha: HEAD, failedChecks: ["tests (server 3/6)", "CI result"], releasedHold: null });
      expect(await activityOf(seeded, "issue.ci_infra_retry_needed")).toHaveLength(0);
      expect(service.resolveCiReturnFacts).toHaveBeenCalledTimes(1);
      expect(service.wakeup).toHaveBeenCalledTimes(1);
      expect(service.wakeup).toHaveBeenCalledWith(seeded.executorId, expect.objectContaining({
        reason: "ci_completed",
        payload: expect.objectContaining({ conclusion: "failure", headSha: HEAD, pullRequestNumber: 123 }),
      }));
    });

    it("holds a head whose main-green is red, once, and returns it when main-green passes again", async () => {
      const seeded = await seedTask();
      let head = redHead(["tests (serialized 1/2)", "CI result", "main-green"]);
      const service = startService({ readHead: () => head });

      await expect(service.deliver([
        ciEvent(seeded, "check_run", "failure", "CI result"),
        ciEvent(seeded, "workflow_run", "failure"),
        ciEvent(seeded, "check_suite", "failure"),
      ])).resolves.toMatchObject({ processed: 3, failed: 0 });

      let task = await taskOf(seeded);
      expect(task).toMatchObject({ status: "in_review", assigneeAgentId: seeded.reviewerId });
      expect(task.executionState).toMatchObject({ status: "pending" });
      expect(task.monitorNextCheckAt).not.toBeNull();
      expect(service.wakeup).not.toHaveBeenCalled();
      let comments = await commentsOf(seeded);
      expect(comments).toHaveLength(1);
      expect(comments[0]!.body).toContain("main-green");
      expect(comments[0]!.body).toContain("tests (serialized 1/2)");
      const holds = await activityOf(seeded, "issue.ci_infra_retry_needed");
      expect(holds).toHaveLength(1);
      expect(holds[0]!.details).toMatchObject({
        reason: "base_branch_red",
        headSha: HEAD,
        failedChecks: ["tests (serialized 1/2)", "CI result", "main-green"],
        source: "github_ci_completion",
      });
      expect(await activityOf(seeded, "issue.ci_failed")).toHaveLength(0);
      expect(await productMetadataOf(seeded)).toMatchObject({
        ciReturnHold: { headSha: HEAD, reason: "base_branch_red" },
        lastCompletedCi: { headSha: HEAD, conclusion: "failure" },
      });

      // Main is green again and the workflow re-ran the gate on this head: the lanes are still red.
      head = redHead(["tests (serialized 1/2)", "CI result"]);
      await expect(service.deliver([ciEvent(seeded, "check_run", "success", "main-green")])).resolves.toMatchObject({ processed: 1, failed: 0 });

      task = await taskOf(seeded);
      expect(task).toMatchObject({ status: "in_progress", assigneeAgentId: seeded.executorId, monitorNextCheckAt: null });
      expect(task.executionState).toMatchObject({ status: "changes_requested" });
      comments = await commentsOf(seeded);
      expect(comments).toHaveLength(2);
      const returnComment = comments.find((comment) => comment.body.includes("CI failure"));
      expect(returnComment?.body).toContain("Failed checks: tests (serialized 1/2), CI result.");
      expect(returnComment?.body).toContain("re-run the failed jobs");
      const returns = await activityOf(seeded, "issue.ci_failed");
      expect(returns).toHaveLength(1);
      expect(returns[0]!.details).toMatchObject({ conclusion: "failure", releasedHold: "base_branch_red" });
      expect(await productMetadataOf(seeded)).not.toHaveProperty("ciReturnHold");
      expect(service.wakeup).toHaveBeenCalledTimes(1);
      expect(service.wakeup).toHaveBeenCalledWith(seeded.executorId, expect.objectContaining({
        reason: "ci_completed",
        payload: expect.objectContaining({ conclusion: "failure", headSha: HEAD }),
        idempotencyKey: `ci_completed:${REPO}:123:${HEAD}:hold-released`,
      }));
    });

    it("holds a head on which only the aggregate failed and lifts the hold on a green re-run", async () => {
      const seeded = await seedTask();
      let head = redHead(["CI result"]);
      const service = startService({ readHead: () => head });

      await expect(service.deliver([ciEvent(seeded, "check_run", "failure", "CI result")])).resolves.toMatchObject({ processed: 1, failed: 0 });

      expect(await taskOf(seeded)).toMatchObject({ status: "in_review", assigneeAgentId: seeded.reviewerId });
      expect((await taskOf(seeded)).monitorNextCheckAt).not.toBeNull();
      expect(service.wakeup).not.toHaveBeenCalled();
      const holds = await activityOf(seeded, "issue.ci_infra_retry_needed");
      expect(holds).toHaveLength(1);
      expect(holds[0]!.details).toMatchObject({ reason: "ci_infra_only", failedChecks: ["CI result"] });
      expect((await productMetadataOf(seeded)).ciReturnHold).toMatchObject({ headSha: HEAD, reason: "ci_infra_only" });

      // The jobs were re-run and the head is green: nothing to return, the hold is over.
      head = GREEN_HEAD;
      await expect(service.deliver([ciEvent(seeded, "check_run", "success", "CI result")])).resolves.toMatchObject({ processed: 1, failed: 0 });

      expect(await taskOf(seeded)).toMatchObject({ status: "in_review", assigneeAgentId: seeded.reviewerId, monitorNextCheckAt: null });
      const metadata = await productMetadataOf(seeded);
      expect(metadata).not.toHaveProperty("ciReturnHold");
      expect(metadata).toMatchObject({ lastCompletedCi: { headSha: HEAD, conclusion: "success" } });
      expect(await activityOf(seeded, "issue.ci_failed")).toHaveLength(0);
      expect(await commentsOf(seeded)).toHaveLength(1);
      // The green result of the head: the assignee of the review stage hears about it.
      expect(service.wakeup).toHaveBeenCalledTimes(1);
      expect(service.wakeup).toHaveBeenCalledWith(seeded.reviewerId, expect.objectContaining({
        reason: "ci_completed",
        payload: expect.objectContaining({ conclusion: "success" }),
      }));
    });

    it("returns the task on the final failure without the failed checks when GitHub cannot be read", async () => {
      const seeded = await seedTask();
      const service = startService({ readHead: () => ({ state: "unknown", reason: "check_runs:http_500" }) });

      await expect(service.deliver([ciEvent(seeded, "check_run", "failure", "CI result")])).resolves.toMatchObject({ processed: 1, failed: 0 });

      expect(service.resolveCiReturnFacts).toHaveBeenCalledTimes(1);
      expect(await taskOf(seeded)).toMatchObject({ status: "in_progress", assigneeAgentId: seeded.executorId });
      const comments = await commentsOf(seeded);
      expect(comments).toHaveLength(1);
      expect(comments[0]!.body).toContain("CI failure");
      expect(comments[0]!.body).not.toContain("Failed checks");
      expect(await activityOf(seeded, "issue.ci_infra_retry_needed")).toHaveLength(0);
      expect(service.wakeup).toHaveBeenCalledTimes(1);
      expect(service.wakeup).toHaveBeenCalledWith(seeded.executorId, expect.objectContaining({ reason: "ci_completed" }));
    });

    it("holds nothing with the return guard switched off: every failed final result returns the task", async () => {
      const seeded = await seedTask();
      const service = startService({
        readHead: () => redHead(["tests (serialized 1/2)", "CI result", "main-green"]),
        env: { MYRMIDON_REVIEW_RETURN_GUARD_ENABLED: "off" },
      });

      // Still by the final result only: a lane changes nothing.
      await expect(service.deliver([ciEvent(seeded, "check_run", "failure", "tests (serialized 1/2)")])).resolves.toMatchObject({ processed: 1, failed: 0 });
      expect(await taskOf(seeded)).toMatchObject({ status: "in_review", assigneeAgentId: seeded.reviewerId });

      await expect(service.deliver([ciEvent(seeded, "check_run", "failure", "CI result")])).resolves.toMatchObject({ processed: 1, failed: 0 });

      expect(await taskOf(seeded)).toMatchObject({ status: "in_progress", assigneeAgentId: seeded.executorId });
      expect(await activityOf(seeded, "issue.ci_infra_retry_needed")).toHaveLength(0);
      expect(await activityOf(seeded, "issue.ci_failed")).toHaveLength(1);
      expect(await productMetadataOf(seeded)).not.toHaveProperty("ciReturnHold");
      expect(service.wakeup).toHaveBeenCalledTimes(1);
      expect(service.wakeup).toHaveBeenCalledWith(seeded.executorId, expect.objectContaining({ reason: "ci_completed" }));
    });
  });

  describe("the old handling", () => {
    it("returns the task on the first failed delivery when the handling by the final result is switched off", async () => {
      const seeded = await seedTask();
      const service = startService({
        readHead: () => redHead(["tests (serialized 1/2)", "CI result", "main-green"]),
        env: { MYRMIDON_GITHUB_CI_FINAL_ONLY_ENABLED: "off" },
      });

      await expect(service.deliver([ciEvent(seeded, "check_run", "failure", "tests (server 3/6)")])).resolves.toMatchObject({ processed: 1, failed: 0 });

      expect(service.resolveCiReturnFacts).not.toHaveBeenCalled();
      expect(await taskOf(seeded)).toMatchObject({ status: "in_progress", assigneeAgentId: seeded.executorId, monitorNextCheckAt: null });
      expect(await activityOf(seeded, "issue.ci_failed")).toHaveLength(1);
      expect(service.wakeup).toHaveBeenCalledTimes(1);
      expect(service.wakeup).toHaveBeenCalledWith(seeded.executorId, expect.objectContaining({ reason: "ci_completed" }));
    });

    it("treats every completed delivery as a finished CI when no reader of the check runs is wired", async () => {
      const seeded = await seedTask({ executing: true });
      const service = startService();

      await expect(service.deliver([ciEvent(seeded, "check_run", "success", "typecheck + build")])).resolves.toMatchObject({ processed: 1, failed: 0 });

      expect((await taskOf(seeded)).monitorNextCheckAt).toBeNull();
      expect(await productMetadataOf(seeded)).toMatchObject({ lastCompletedCi: { headSha: HEAD, conclusion: "success" } });
      expect(service.wakeup).toHaveBeenCalledTimes(1);
    });
  });

  describe("the wake of a delivery", () => {
    // The admission of a wake locks the task row. A wake sent from inside the
    // transaction of the delivery would wait for the row the delivery itself
    // has written, so it is sent once the delivery has committed: at that
    // moment another connection already sees what the delivery wrote.
    it.each([
      ["by the final result of the head", true],
      ["in the old handling", false],
    ])("is sent after the delivery has committed (%s)", async (_name, withReader) => {
      const seeded = await seedTask({ executing: true });
      const seenAtWake: Array<{ monitorNextCheckAt: Date | null; deliveries: string[] }> = [];
      const service = startService({
        ...(withReader ? { readHead: () => GREEN_HEAD } : {}),
        onWake: async () => {
          const [task] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
          const receipts = await db.select().from(connectionEventDeliveries).where(eq(connectionEventDeliveries.companyId, seeded.companyId));
          seenAtWake.push({ monitorNextCheckAt: task?.monitorNextCheckAt ?? null, deliveries: receipts.map((receipt) => receipt.status) });
        },
      });

      await expect(service.deliver([ciEvent(seeded, "check_run", "success", "CI result")])).resolves.toMatchObject({ processed: 1, failed: 0 });

      expect(service.wakeup).toHaveBeenCalledTimes(1);
      // The disarmed monitor and the processed receipt are committed by the time the wake is sent.
      expect(seenAtWake).toEqual([{ monitorNextCheckAt: null, deliveries: ["processed"] }]);
    });
  });

  describe("a delivery rolled back by a deadlock and run again (EMPTY-RUNS-3)", () => {
    // The comment, the `ci_infra_retry_needed` row and the return of the task are
    // written in the transaction of the delivery, so the rollback takes them away
    // and the second run writes them once. The notice to the board merge goes out
    // after the commit, once.
    it("creates the comment and the hold record once for a held head", async () => {
      const seeded = await seedTask();
      const service = startService({
        readHead: () => redHead(["tests (serialized 1/2)", "CI result", "main-green"]),
        deadlockFirstTransaction: true,
      });

      await expect(service.deliver([ciEvent(seeded, "check_run", "failure", "CI result")])).resolves.toMatchObject({ processed: 1, failed: 0 });

      expect(await commentsOf(seeded)).toHaveLength(1);
      expect(await activityOf(seeded, "issue.ci_infra_retry_needed")).toHaveLength(1);
      expect(await activityOf(seeded, "issue.ci_failed")).toHaveLength(0);
      expect(await taskOf(seeded)).toMatchObject({ status: "in_review", assigneeAgentId: seeded.reviewerId });
      expect(await productMetadataOf(seeded)).toMatchObject({ ciReturnHold: { headSha: HEAD, reason: "base_branch_red" } });
    });

    it("returns the task once and wakes the executor once", async () => {
      const seeded = await seedTask();
      const service = startService({ readHead: () => redHead(["tests (server 3/6)", "CI result"]), deadlockFirstTransaction: true });

      await expect(service.deliver([ciEvent(seeded, "check_run", "failure", "CI result")])).resolves.toMatchObject({ processed: 1, failed: 0 });

      expect(await commentsOf(seeded)).toHaveLength(1);
      expect(await activityOf(seeded, "issue.ci_failed")).toHaveLength(1);
      expect(await taskOf(seeded)).toMatchObject({ status: "in_progress", assigneeAgentId: seeded.executorId });
      expect(service.wakeup).toHaveBeenCalledTimes(1);
    });
  });
});
