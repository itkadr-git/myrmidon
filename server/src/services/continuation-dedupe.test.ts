import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { activityLog, agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issueContinuationKeys, issues, type Db } from "@myrmidon/db";
import { heartbeatService } from "./heartbeat.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { clearExpiredContinuationKeys, tryClaimContinuationKey, tryClaimContinuationKeyInTransaction } from "./continuation-dedupe.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("continuation dedupe (P1.9)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  const companyId = randomUUID();
  const issueId = randomUUID();

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-continuation-dedupe-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({
      id: companyId,
      name: "Continuation Dedupe Co",
      issuePrefix: "CDD",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Continuation Dedupe Task",
      status: "in_progress",
    });
  }, 60_000);

  afterAll(async () => {
    await database?.cleanup();
  }, 60_000);

  it("50 parallel calls with the same key -> 1 created, 49 deduped", async () => {
    const key = `race-key-${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        tryClaimContinuationKey(db, {
          companyId,
          key,
          issueId,
          ttl: 60_000,
        }),
      ),
    );

    const created = results.filter((r) => r === "created");
    const deduped = results.filter((r) => r === "deduped");
    expect(created).toHaveLength(1);
    expect(deduped).toHaveLength(49);

    const storedRows = await db
      .select()
      .from(issueContinuationKeys)
      .where(and(eq(issueContinuationKeys.companyId, companyId), eq(issueContinuationKeys.key, key)));
    expect(storedRows).toHaveLength(1);
    expect(storedRows[0]?.issueId).toBe(issueId);
  }, 30_000);

  it("transaction-scoped claims race through the shared admission transaction", async () => {
    const key = `transaction-race-${randomUUID()}`;
    const outcomes = await Promise.all(Array.from({ length: 20 }, () =>
      db.transaction((tx) => tryClaimContinuationKeyInTransaction(tx as unknown as Db, {
        companyId, key, issueId, ttl: 60_000,
      })),
    ));
    expect(outcomes.filter((outcome) => outcome === "created")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "deduped")).toHaveLength(19);
  }, 30_000);

  it("a transaction rollback releases the claim for a later admission", async () => {
    const key = `rollback-key-${randomUUID()}`;
    await expect(db.transaction(async (tx) => {
      expect(await tryClaimContinuationKeyInTransaction(tx as unknown as Db, {
        companyId,
        key,
        issueId,
        ttl: 60_000,
      })).toBe("created");
      throw new Error("force admission rollback");
    })).rejects.toThrow("force admission rollback");

    expect(await tryClaimContinuationKey(db, {
      companyId,
      key,
      issueId,
      ttl: 60_000,
    })).toBe("created");
  }, 30_000);

  it("different keys are independent", async () => {
    const key1 = `independent-key-1-${randomUUID()}`;
    const key2 = `independent-key-2-${randomUUID()}`;
    const key3 = `independent-key-3-${randomUUID()}`;

    const [res1, res2, res3] = await Promise.all([
      tryClaimContinuationKey(db, { companyId, key: key1, issueId, ttl: 60_000 }),
      tryClaimContinuationKey(db, { companyId, key: key2, issueId, ttl: 60_000 }),
      tryClaimContinuationKey(db, { companyId, key: key3, issueId, ttl: 60_000 }),
    ]);

    expect(res1).toBe("created");
    expect(res2).toBe("created");
    expect(res3).toBe("created");
  });

  it("expired key can be claimed again", async () => {
    const key = `expiring-key-${randomUUID()}`;
    // Claim with a short TTL (50ms)
    const firstClaim = await tryClaimContinuationKey(db, {
      companyId,
      key,
      issueId,
      ttl: 50,
    });
    expect(firstClaim).toBe("created");

    // Second claim immediately should be deduped
    const immediateRepeat = await tryClaimContinuationKey(db, {
      companyId,
      key,
      issueId,
      ttl: 60_000,
    });
    expect(immediateRepeat).toBe("deduped");

    // Wait for the original 50ms TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 80));

    // After expiration, claiming again should succeed with 'created'
    const afterExpiration = await tryClaimContinuationKey(db, {
      companyId,
      key,
      issueId,
      ttl: 60_000,
    });
    expect(afterExpiration).toBe("created");
  });

  it("clearExpiredContinuationKeys removes expired keys and returns the count", async () => {
    const expiredKey = `manual-expired-${randomUUID()}`;
    const activeKey = `manual-active-${randomUUID()}`;

    await tryClaimContinuationKey(db, { companyId, key: expiredKey, issueId, ttl: 50 });
    await tryClaimContinuationKey(db, { companyId, key: activeKey, issueId, ttl: 60_000 });

    await new Promise((resolve) => setTimeout(resolve, 80));

    const clearedCount = await clearExpiredContinuationKeys(db, companyId);
    expect(clearedCount).toBeGreaterThanOrEqual(1);

    // Active key must still be in the database
    const activeRows = await db
      .select()
      .from(issueContinuationKeys)
      .where(and(eq(issueContinuationKeys.companyId, companyId), eq(issueContinuationKeys.key, activeKey)));
    expect(activeRows).toHaveLength(1);
  });

  describe("heartbeat continuation admission (acceptance scenarios)", () => {
    const hbAgentId = randomUUID();
    const hbIssueId = randomUUID();

    beforeAll(async () => {
      await db.insert(agents).values({
        id: hbAgentId,
        companyId,
        name: "Continuation Agent",
        role: "engineer",
        status: "idle",
        adapterType: "test_adapter",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      });
      await db.insert(issues).values({
        id: hbIssueId,
        companyId,
        title: "HB Continuation Task",
        status: "in_progress",
        assigneeAgentId: hbAgentId,
      });
    });

    it("absence of new event after prior run does not wake model (skipped with no_new_issue_input)", async () => {
      const heartbeat = heartbeatService(db);
      const priorRunId = randomUUID();
      const finishedAt = new Date(Date.now() - 60_000);
      await db.insert(heartbeatRuns).values({
        id: priorRunId,
        companyId,
        agentId: hbAgentId,
        status: "succeeded",
        createdAt: new Date(finishedAt.getTime() - 10_000),
        finishedAt,
        contextSnapshot: { issueId: hbIssueId },
      });

      const outcome = await heartbeat.wakeup(hbAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_continuation_needed",
        requestedByActorType: "system",
        payload: { issueId: hbIssueId },
        contextSnapshot: { issueId: hbIssueId },
      });

      expect(outcome).toBeNull();
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, hbAgentId));
      expect(runs).toHaveLength(1);
      const receipts = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, hbAgentId));
      const skipped = receipts.find(
        (r) => r.status === "skipped" && (r.payload as Record<string, unknown>)?.continuationSkipped === "no_new_issue_input",
      );
      expect(skipped).toBeDefined();
    });

    it("new event revision after prior run admits exactly one run", async () => {
      const heartbeat = heartbeatService(db);
      const activityId = randomUUID();
      await db.insert(activityLog).values({
        id: activityId,
        companyId,
        actorType: "user",
        actorId: "test-user",
        action: "issue.comment_added",
        entityType: "issue",
        entityId: hbIssueId,
        createdAt: new Date(),
      });

      const outcome = await heartbeat.wakeup(hbAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_continuation_needed",
        requestedByActorType: "system",
        payload: { issueId: hbIssueId },
        contextSnapshot: { issueId: hbIssueId },
      });

      expect(outcome).not.toBeNull();
      await heartbeat.drainActiveRunExecutions();

      // Subsequent wake with no newer event is skipped
      const secondWake = await heartbeat.wakeup(hbAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_continuation_needed",
        requestedByActorType: "system",
        payload: { issueId: hbIssueId },
        contextSnapshot: { issueId: hbIssueId },
      });
      expect(secondWake).toBeNull();
    });

    it("duplicate/parallel delivery of same event revision admits exactly one run and dedupes the rest", async () => {
      const heartbeat = heartbeatService(db);
      const activityId = randomUUID();
      await db.insert(activityLog).values({
        id: activityId,
        companyId,
        actorType: "user",
        actorId: "test-user",
        action: "issue.comment_added",
        entityType: "issue",
        entityId: hbIssueId,
        createdAt: new Date(),
      });

      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          heartbeat.wakeup(hbAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_continuation_needed",
            requestedByActorType: "system",
            payload: { issueId: hbIssueId },
            contextSnapshot: { issueId: hbIssueId },
          }),
        ),
      );

      const admitted = results.filter(Boolean);
      expect(admitted).toHaveLength(1);
      await heartbeat.drainActiveRunExecutions();

      const receipts = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, hbAgentId));
      const dedupedReceipts = receipts.filter(
        (r) =>
          r.status === "skipped" &&
          (Boolean((r.payload as Record<string, unknown>)?.duplicateContinuation) ||
            (r.payload as Record<string, unknown>)?.continuationSkipped === "duplicate_event_revision"),
      );
      expect(dedupedReceipts.length).toBeGreaterThanOrEqual(4);
    });

    it("recovery of interrupted/failed run is admitted and preserves recovery parent run and revision", async () => {
      const heartbeat = heartbeatService(db);
      const failedRunId = randomUUID();

      const outcome = await heartbeat.wakeup(hbAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_continuation_needed",
        requestedByActorType: "system",
        failedRunId,
        payload: { issueId: hbIssueId, retryOfRunId: failedRunId },
        contextSnapshot: { issueId: hbIssueId, retryOfRunId: failedRunId },
      });

      expect(outcome).not.toBeNull();
      await heartbeat.drainActiveRunExecutions();

      const recoveryRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, outcome!.runId));
      expect(recoveryRuns).toHaveLength(1);
      const snapshot = recoveryRuns[0]?.contextSnapshot as Record<string, unknown>;
      expect(snapshot?.retryOfRunId).toBe(failedRunId);
      expect(snapshot?.continuationEventRevision).toBe(`recovery:${failedRunId}`);

      // Duplicate recovery wake for the same parent run is deduped
      const duplicateRecovery = await heartbeat.wakeup(hbAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_continuation_needed",
        requestedByActorType: "system",
        failedRunId,
        payload: { issueId: hbIssueId, retryOfRunId: failedRunId },
        contextSnapshot: { issueId: hbIssueId, retryOfRunId: failedRunId },
      });
      expect(duplicateRecovery).toBeNull();
    });
  });
});
