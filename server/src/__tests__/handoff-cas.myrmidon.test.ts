// myrmidon(HANDOFF-CAS): guarded agent-to-agent task handoff through the
// general PATCH /api/issues/{id} path, ported from vendor
// paperclipai/paperclip#13686. Covers: CAS compare under the row lock (409
// issue_reassignment_conflict on owner/version mismatch), the applied receipt
// with statusVersion bump and todo demote, replay idempotency (duplicate
// receipt without mutation; idempotency_conflict on same key different
// fingerprint), forbidden handoff states, the commit fence when a live run of
// the previous owner still exists between the stop and the commit (409 +
// guarded rollback receipt), two concurrent handoffs applying exactly once,
// and API compatibility without CAS fields.

import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres handoff CAS tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type TestDb = ReturnType<typeof createDb>;

describeEmbeddedPostgres("guarded CAS handoff on PATCH /api/issues/{id}", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-handoff-cas-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    // myrmidon(HANDOFF-CAS): the PATCH route fires background work off-list
    // (wakeup enqueues, hire/skill/foraging inserts), so a hand-written FK
    // delete ladder always lags one table behind whatever the background
    // services touch next (23503 on companies via company_skills, then
    // deadlock races against in-flight FK share-locks). Heartbeat-adjacent
    // suites in this package solve the same problem with a cascade truncate
    // (heartbeat-active-run-output-watchdog, issue-queued-comments); keep the
    // whole companies cluster in one statement and retry while background
    // transactions still hold locks (deadlock victims can simply rerun).
    let lastError: unknown = null;
    let delay = 100;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
        return;
      } catch (err) {
        lastError = err;
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 1_500);
      }
    }
    throw lastError;
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 }).catch(() => {});
    await tempDb?.cleanup();
    tempDb = null;
    db = undefined as never;
  });

  async function seedFixture(opts?: {
    status?: string;
    statusVersion?: number;
    liveRunsForOwner?: number;
  }) {
    const companyId = randomUUID();
    const userId = `user-${randomUUID()}`;
    await db.insert(companies).values({
      id: companyId,
      name: `Handoff CAS Co ${companyId}`,
      issuePrefix: `H${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: userId,
      membershipRole: "owner",
      grantedByUserId: null,
    });
    const seededAgents = await db
      .insert(agents)
      .values([
        { companyId, name: "agent-old", role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
        { companyId, name: "agent-new", role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
        { companyId, name: "agent-third", role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      ] as never)
      .returning();
    const [oldAgent, newAgent, thirdAgent] = seededAgents;
    const issueId = randomUUID();
    await db
      .insert(issues)
      .values({
        id: issueId,
        companyId,
        title: "Guarded handoff target",
        status: opts?.status ?? "in_progress",
        priority: "medium",
        assigneeAgentId: oldAgent!.id,
        statusVersion: opts?.statusVersion ?? 4,
      } as never);
    const runIds: string[] = [];
    for (let i = 0; i < (opts?.liveRunsForOwner ?? 0); i += 1) {
      const runId = randomUUID();
      runIds.push(runId);
      await db
        .insert(heartbeatRuns)
        .values({
          id: runId,
          companyId,
          agentId: oldAgent!.id,
          status: "running",
          contextSnapshot: { issueId, taskId: issueId },
        } as never);
    }
    if (runIds.length > 0) {
      await db
        .update(issues)
        .set({ executionRunId: runIds[0]! })
        .where(eq(issues.id, issueId));
    }
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as { actor?: unknown }).actor = {
        type: "board",
        source: "session",
        userId,
        companyIds: [companyId],
        memberships: [
          { companyId, membershipRole: "owner", status: "active" },
        ],
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    return {
      app,
      companyId,
      oldAgentId: oldAgent!.id,
      newAgentId: newAgent!.id,
      thirdAgentId: thirdAgent!.id,
      issueId,
      runIds,
    };
  }

  async function readIssueRow(issueId: string) {
    const rows = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        statusVersion: issues.statusVersion,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId));
    return rows[0]!;
  }

  async function receipts(issueId: string) {
    return db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityType, "issue"),
          eq(activityLog.entityId, issueId),
          eq(activityLog.action, "issue.reassigned"),
        ),
      );
  }

  // The route flushes assignment wakes fire-and-forget after the response,
  // so the new owner's wake may materialize as a wakeup request (deferred or
  // guarded paths) or as a run (immediate dispatch). Poll both tables for a
  // trace of this issue's wake for the agent.
  async function waitForWake(
    agentId: string,
    issueId: string,
    idempotencyKey?: string,
  ) {
    const deadline = Date.now() + 5_000;
    for (;;) {
      if (idempotencyKey) {
        const keyed = await db
          .select()
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.agentId, agentId),
              eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
            ),
          );
        if (keyed.length > 0) return keyed[0]!;
      }
      const rows = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, agentId));
      const byPayload = rows.find(
        (r) =>
          (r.payload as Record<string, unknown> | null)?.issueId === issueId,
      );
      if (byPayload) return byPayload;
      const runs = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      const byRun = runs.find(
        (r) =>
          (r.contextSnapshot as Record<string, unknown> | null)?.issueId ===
          issueId,
      );
      if (byRun) return byRun;
      if (Date.now() > deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async function wakeCountFor(agentId: string, issueId: string) {
    const rows = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    const requests = rows.filter(
      (r) => (r.payload as Record<string, unknown> | null)?.issueId === issueId,
    ).length;
    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    const runCount = runs.filter(
      (r) =>
        (r.contextSnapshot as Record<string, unknown> | null)?.issueId ===
        issueId,
    ).length;
    return requests + runCount;
  }

  it("applies a guarded handoff: writes owner, bumps statusVersion, demotes to todo, records the applied receipt, wakes the new owner", async () => {
    const { app, oldAgentId, newAgentId, issueId } = await seedFixture({
      statusVersion: 4,
    });
    const commandId = randomUUID();

    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({
        assigneeAgentId: newAgentId,
        expectedAssigneeAgentId: oldAgentId,
        expectedStatusVersion: 4,
        handoffIdempotencyKey: commandId,
        reason: "planned rotation",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = await readIssueRow(issueId);
    expect(row.assigneeAgentId).toBe(newAgentId);
    expect(row.statusVersion).toBe(5);
    expect(row.status).toBe("todo");
    expect(res.body.handoffReceipt).toMatchObject({
      commandId,
      disposition: "applied",
      stateRevision: 5,
      scheduledWakeKeys: [`handoff:${commandId}:owner:${issueId}`],
    });

    const rec = await receipts(issueId);
    expect(rec).toHaveLength(1);
    expect((rec[0]!.details as Record<string, unknown>).disposition).toBe("applied");

    const wake = await waitForWake(newAgentId, issueId, `handoff:${commandId}:owner:${issueId}`);
    expect(wake, "the new owner must be woken under the handoff key").toBeTruthy();
  });

  it("rejects a stale owner expectation with 409 issue_reassignment_conflict and a conflict receipt", async () => {
    const { app, newAgentId, issueId } = await seedFixture({ statusVersion: 4 });
    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({
        assigneeAgentId: newAgentId,
        expectedAssigneeAgentId: randomUUID(),
        expectedStatusVersion: 4,
      });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain("issue_reassignment_conflict");
    const row = await readIssueRow(issueId);
    expect(row.statusVersion).toBe(4);
    const rec = await receipts(issueId);
    expect(rec).toHaveLength(1);
    expect((rec[0]!.details as Record<string, unknown>).disposition).toBe("conflict");
  });

  it("rejects a stale statusVersion expectation with 409", async () => {
    const { app, oldAgentId, newAgentId, issueId } = await seedFixture({ statusVersion: 4 });
    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({
        assigneeAgentId: newAgentId,
        expectedAssigneeAgentId: oldAgentId,
        expectedStatusVersion: 3,
      });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain("issue_reassignment_conflict");
  });

  it("requires both CAS fields together", async () => {
    const { app, newAgentId, issueId } = await seedFixture({ statusVersion: 4 });
    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ assigneeAgentId: newAgentId, expectedStatusVersion: 4 });
    expect(res.status).toBe(422);
    const rec = await receipts(issueId);
    expect(rec).toHaveLength(0);
  });

  it("replays the same command and fingerprint as a duplicate receipt without mutating or re-waking", async () => {
    const { app, oldAgentId, newAgentId, issueId } = await seedFixture({
      statusVersion: 4,
    });
    const commandId = randomUUID();
    const body = {
      assigneeAgentId: newAgentId,
      expectedAssigneeAgentId: oldAgentId,
      expectedStatusVersion: 4,
      handoffIdempotencyKey: commandId,
      reason: "planned rotation",
    };

    const first = await request(app).patch(`/api/issues/${issueId}`).send(body);
    expect(first.status, JSON.stringify(first.body)).toBe(200);

    // Replay after success: the stored receipt answers — no fresh mutation,
    // no second wake, even though the row has already moved and the assignee
    // change no longer applies.
    const second = await request(app).patch(`/api/issues/${issueId}`).send(body);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.handoffReceipt?.disposition).toBe("duplicate");

    const row = await readIssueRow(issueId);
    expect(row.statusVersion).toBe(5);
    const rec = await receipts(issueId);
    expect(rec).toHaveLength(1);
    // The first request's wake flushes fire-and-forget after the response;
    // wait for its materialization before counting, then assert the replay
    // added nothing.
    await waitForWake(newAgentId, issueId, `handoff:${commandId}:owner:${issueId}`);
    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, newAgentId));
    expect(
      wakes.filter((w) => w.idempotencyKey === `handoff:${commandId}:owner:${issueId}`),
    ).toHaveLength(1);
  });

  it("rejects the same command id reused with a different payload as 409 idempotency_conflict", async () => {
    const { app, oldAgentId, newAgentId, thirdAgentId, issueId } =
      await seedFixture({ statusVersion: 4 });
    const commandId = randomUUID();
    const first = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({
        assigneeAgentId: newAgentId,
        expectedAssigneeAgentId: oldAgentId,
        expectedStatusVersion: 4,
        handoffIdempotencyKey: commandId,
      });
    expect(first.status).toBe(200);

    const second = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({
        assigneeAgentId: thirdAgentId,
        expectedAssigneeAgentId: newAgentId,
        expectedStatusVersion: 5,
        handoffIdempotencyKey: commandId,
      });
    expect(second.status).toBe(409);
    expect(JSON.stringify(second.body)).toContain("idempotency_conflict");
    const row = await readIssueRow(issueId);
    expect(row.assigneeAgentId).toBe(newAgentId);
  });

  it("refuses guarded handoff from forbidden states in_review/done/cancelled", async () => {
    for (const status of ["in_review", "done", "cancelled"] as const) {
      const { app, oldAgentId, newAgentId, issueId } = await seedFixture({
        status,
        statusVersion: 2,
      });
      const res = await request(app)
        .patch(`/api/issues/${issueId}`)
        .send({
          assigneeAgentId: newAgentId,
          expectedAssigneeAgentId: oldAgentId,
          expectedStatusVersion: 2,
        });
      expect(res.status, status).toBe(409);
      expect(JSON.stringify(res.body), status).toContain(
        "issue_reassignment_conflict",
      );
      const row = await readIssueRow(issueId);
      expect(row.statusVersion).toBe(2);
    }
  });

  it("keeps the old behavior when no CAS fields are sent", async () => {
    const { app, newAgentId, issueId } = await seedFixture({ statusVersion: 4 });
    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ assigneeAgentId: newAgentId });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = await readIssueRow(issueId);
    expect(row.assigneeAgentId).toBe(newAgentId);
    expect(row.statusVersion).toBe(4);
    expect(res.body.handoffReceipt).toBeUndefined();
    const rec = await receipts(issueId);
    expect(rec).toHaveLength(0);
  });

  it("applies exactly one of two concurrent guarded handoffs", async () => {
    const { app, oldAgentId, newAgentId, thirdAgentId, issueId } =
      await seedFixture({ statusVersion: 9 });
    const [a, b] = await Promise.all([
      request(app)
        .patch(`/api/issues/${issueId}`)
        .send({
          assigneeAgentId: newAgentId,
          expectedAssigneeAgentId: oldAgentId,
          expectedStatusVersion: 9,
        }),
      request(app)
        .patch(`/api/issues/${issueId}`)
        .send({
          assigneeAgentId: thirdAgentId,
          expectedAssigneeAgentId: oldAgentId,
          expectedStatusVersion: 9,
        }),
    ]);
    const applied = [a, b].filter((r) => r.status === 200);
    const rejected = [a, b].filter((r) => r.status === 409);
    expect(applied, JSON.stringify([a.body, b.body])).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const row = await readIssueRow(issueId);
    expect([newAgentId, thirdAgentId]).toContain(row.assigneeAgentId);
    expect(row.statusVersion).toBe(10);
    // The final owner is the applied request's target.
    expect(row.assigneeAgentId).toBe(
      (applied[0]!.body as { handoffReceipt?: { toAssigneeAgentId?: string } })
        .handoffReceipt?.toAssigneeAgentId ??
      (applied[0]!.body as { assigneeAgentId?: string }).assigneeAgentId,
    );
  });

  it("refuses the commit and rolls back when a live run of the previous owner still exists between the stop and the commit", async () => {
    // Two live runs for the old owner: the stop phase cancels the run bound
    // to the issue; the second one is the race — a run that started (or was
    // queued) between the stop and the commit. The commit fence (re-read
    // under FOR UPDATE) must refuse with reassignment_stop_unconfirmed, the
    // guarded rollback must record its receipt, the new owner must not be
    // woken, and the issue must keep its old owner at an unchanged version.
    const { app, oldAgentId, newAgentId, issueId } = await seedFixture({
      statusVersion: 4,
      liveRunsForOwner: 2,
    });
    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({
        assigneeAgentId: newAgentId,
        expectedAssigneeAgentId: oldAgentId,
        expectedStatusVersion: 4,
      });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(JSON.stringify(res.body)).toContain("reassignment_stop_unconfirmed");

    const row = await readIssueRow(issueId);
    expect(row.assigneeAgentId).toBe(oldAgentId);
    expect(row.statusVersion).toBe(4);

    expect(await wakeCountFor(newAgentId, issueId)).toBe(0);

    const rec = await receipts(issueId);
    const dispositions = rec.map((r) => (r.details as Record<string, unknown>).disposition);
    expect(dispositions).toContain("rollback");
  });
});
