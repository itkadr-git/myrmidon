import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../../__tests__/helpers/embedded-postgres.js";
import { createPostgresRunDispatchAdapter } from "./postgres.js";

// OPE-12289: the timeout gate must mark a run cancelled before dispatch so
// the existing failedBeforeModel daily-cap exclusion can recognize it.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres run-dispatch failedBeforeModel tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("run-dispatch: failedBeforeModel on queue timeout (OPE-12289)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-dispatch-fbm-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent(): Promise<{ companyId: string; agentId: string }> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedQueuedRun(input: {
    companyId: string;
    agentId: string;
    issueId?: string;
    createdAt: Date;
  }): Promise<string> {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "retry",
      status: "queued",
      contextSnapshot: input.issueId ? { issueId: input.issueId } : {},
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    });
    return runId;
  }

  async function readResultJson(runId: string): Promise<Record<string, unknown>> {
    const [row] = await db
      .select({ resultJson: heartbeatRuns.resultJson })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    return (row?.resultJson ?? {}) as Record<string, unknown>;
  }

  it("stamps failedBeforeModel when a queued run times out (queued_run_stale_timeout)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const queuedAt = new Date(Date.now() - 20 * 60_000);
    const runId = await seedQueuedRun({ companyId, agentId, createdAt: queuedAt });

    const adapter = createPostgresRunDispatchAdapter(db);
    const outcome = await adapter.cancelStaleQueuedRun({
      companyId,
      runId,
      now: new Date(),
      expectedStatus: "queued",
      staleAfterMs: 15 * 60_000,
    });

    expect(outcome).toMatchObject({ outcome: "cancelled", errorCode: "queued_run_stale_timeout" });
    const resultJson = await readResultJson(runId);
    expect(resultJson.failedBeforeModel).toBe(true);
    expect(resultJson.failed_before_model).toBe(true);
    expect(resultJson.stopReason).toBe("queued_run_stale_timeout");
    // The daily-cap exclusion only counts rows with a startedAt in the UTC day
    // window; a timed-out queued run never reached running, so the row must
    // also keep startedAt null to stay out of the cap query entirely.
    const [row] = await db
      .select({ startedAt: heartbeatRuns.startedAt, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    expect(row?.startedAt).toBeNull();
    expect(row?.status).toBe("cancelled");
  });

  it("does not stamp failedBeforeModel when a queued run is still fresh", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const runId = await seedQueuedRun({ companyId, agentId, createdAt: new Date(Date.now() - 60_000) });

    const adapter = createPostgresRunDispatchAdapter(db);
    const outcome = await adapter.cancelStaleQueuedRun({
      companyId,
      runId,
      now: new Date(),
      expectedStatus: "queued",
      staleAfterMs: 15 * 60_000,
    });

    expect(outcome).toMatchObject({ outcome: "not_stale" });
    const resultJson = await readResultJson(runId);
    expect(resultJson.failedBeforeModel).toBeUndefined();
    expect(resultJson.failed_before_model).toBeUndefined();
  });

  it("stamps failedBeforeModel when staleness is decided by the issue-state gate", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "OPE-12289 gate-cancel fixture",
      status: "done",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    const runId = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      createdAt: new Date(Date.now() - 60_000),
    });

    const adapter = createPostgresRunDispatchAdapter(db);
    const outcome = await adapter.cancelStaleQueuedRun({
      companyId,
      runId,
      now: new Date(),
      expectedStatus: "queued",
    });

    expect(outcome).toMatchObject({ outcome: "cancelled", errorCode: "issue_terminal_status" });
    // Same pre-model write path (cancelStaleRunInTx): the flag must be present
    // for any staleness-gate cancellation, not only the timeout code.
    const resultJson = await readResultJson(runId);
    expect(resultJson.failedBeforeModel).toBe(true);
    expect(resultJson.failed_before_model).toBe(true);
  });
});
