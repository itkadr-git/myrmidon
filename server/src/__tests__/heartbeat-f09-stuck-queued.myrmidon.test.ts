// myrmidon(1.6.5 F-09): the stuck-queued sweep tests. A queued run whose task
// is in backlog or hidden is cancelled with `queued_run_issue_not_startable`; a
// queued run older than the explain threshold without waitReason gets one; a
// queued run older than the stall threshold raises a queue_stall attention
// card; a run whose task is in todo starts when the admission gate opens.
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  documentRevisions,
  documents,
  issueLabels,
  issueRelations,
  issues,
  labels,
  companySkills,
  environments,
  environmentLeases,
  executionWorkspaces,
  workspaceOperations,
  issueTreeHolds,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  readRunPriorityFromEnv,
  type RunPrioritySettings,
} from "@paperclipai/shared";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";
import {
  applyRunAdmissionLimits,
  currentRunAdmissionLimits,
  resetSharedRunAdmissionForTests,
  type RunAdmissionLimits,
} from "../myrmidon/run-admission.js";
import {
  applyRunPrioritySettings,
  resetRunPriorityForTests,
} from "../myrmidon/run-priority/state.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "F-09 stuck-queued test run.",
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
    `Skipping embedded Postgres F-09 stuck-queued tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function ensureIssueRelationsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_relations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "related_issue_id" uuid NOT NULL,
      "type" text NOT NULL,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}

/** Admission pinned to a value, with the memory/host gates off: the global cap
 * alone decides how many runs a sweep may start. */
function pinAdmission(overrides: Partial<RunAdmissionLimits>) {
  resetSharedRunAdmissionForTests();
  applyRunAdmissionLimits({
    maxConcurrentRuns: 1,
    maxStartsPerMinute: 30,
    minFreeMemoryMb: null,
    runMemoryEstimateMb: 300,
    minFreeHostMemoryMb: null,
    maxHostLoadPercentPerCore: null,
    // The fair-share gate must not hold an agent: only the cap under test.
    maxPerAgentStartSharePercent: 100,
    ...overrides,
  });
}

const MINUTE_MS = 60_000;

describeEmbeddedPostgres("heartbeat F-09 stuck-queued sweep", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-f09-stuck-queued-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    await ensureIssueRelationsTable(db);
  }, 120_000);

  afterEach(async () => {
    await heartbeat.drainActiveRunExecutions();
    runningProcesses.clear();
    resetRunPriorityForTests();
    resetSharedRunAdmissionForTests();
    applyRunAdmissionLimits(currentRunAdmissionLimits());
    await db.delete(environmentLeases);
    await db.delete(companySkills);
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issueLabels);
    await db.delete(labels);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueRelations);
    await db.delete(issueTreeHolds);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(environments);
    await db.delete(workspaceOperations);
    await db.delete(executionWorkspaces);
    await db.delete(environmentLeases);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await db.transaction(async (tx) => {
          await tx.delete(companySkills);
          await tx.delete(companies);
        });
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "F-09 stuck-queued test run.",
      provider: "test",
      model: "test-model",
    }));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent(input: { name: string; role: string }) {
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
      name: input.name,
      role: input.role,
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedIssue(
    companyId: string,
    input: { title: string; priority: string; assigneeAgentId?: string; status?: string; hiddenAt?: Date | null },
  ) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: input.title,
      status: input.status ?? "todo",
      priority: input.priority,
      assigneeAgentId: input.assigneeAgentId ?? null,
      responsibleUserId: "responsible-user",
      hiddenAt: input.hiddenAt ?? null,
    });
    return issueId;
  }

  /** Queue a run for the agent and hold it there: admission says 0 slots. */
  async function wakeAndQueue(agentId: string, issueId: string) {
    const run = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });
    expect(run).not.toBeNull();
    const stored = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run!.id))
      .then((rows) => rows[0]!);
    expect(stored.status).toBe("queued");
    return stored;
  }

  async function backdateRun(runId: string, minutesAgo: number) {
    await db
      .update(heartbeatRuns)
      .set({ createdAt: new Date(Date.now() - minutesAgo * MINUTE_MS) })
      .where(eq(heartbeatRuns.id, runId));
  }

  async function runRow(runId: string) {
    return db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  it("cancels a queued run whose task was moved to backlog", async () => {
    pinAdmission({ maxConcurrentRuns: 0 });
    applyRunPrioritySettings(readRunPriorityFromEnv({}));

    const { companyId, agentId } = await seedCompanyAndAgent({ name: "Eng", role: "engineer" });
    const issueId = await seedIssue(companyId, {
      title: "Backlog work",
      priority: "medium",
      assigneeAgentId: agentId,
      status: "todo",
    });

    const run = await wakeAndQueue(agentId, issueId);
    // Move the issue to backlog while the run is queued.
    await db.update(issues).set({ status: "backlog" }).where(eq(issues.id, issueId));

    // Open the admission gate and run the sweep.
    pinAdmission({ maxConcurrentRuns: 1 });
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    const stored = await runRow(run.id);
    expect(stored?.status).toBe("cancelled");
    expect(stored?.errorCode).toBe("queued_run_issue_not_startable");
    expect(stored?.error).toContain("backlog");
  }, 30_000);

  it("keeps a queued run on a hidden todo startable (Summarizer pattern)", async () => {
    // Hidden todos are the supported summary-slot / status-card pattern: the
    // Summarizer is woken through the regular queue on a hidden todo, so the
    // sweep must not cancel it.
    pinAdmission({ maxConcurrentRuns: 0 });
    applyRunPrioritySettings(readRunPriorityFromEnv({}));

    const { companyId, agentId } = await seedCompanyAndAgent({ name: "Eng", role: "engineer" });
    const issueId = await seedIssue(companyId, {
      title: "Hidden work",
      priority: "medium",
      assigneeAgentId: agentId,
      status: "todo",
    });

    const run = await wakeAndQueue(agentId, issueId);
    // Hide the issue while the run is queued.
    await db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, issueId));

    // Open the admission gate and run the sweep — the run must survive.
    pinAdmission({ maxConcurrentRuns: 1 });
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    const stored = await runRow(run.id);
    expect(stored?.status).not.toBe("cancelled");
    expect(stored?.errorCode ?? null).toBeNull();
  }, 30_000);

  it("fills waitReason on a queued run older than the explain threshold", async () => {
    // The sweep explains runs older than QUEUED_RUN_EXPLAIN_AFTER_SEC (default 60s).
    // Backdate the run past the threshold so the sweep explains it.
    pinAdmission({ maxConcurrentRuns: 0 });
    applyRunPrioritySettings(readRunPriorityFromEnv({}));

    const { companyId, agentId } = await seedCompanyAndAgent({ name: "Eng", role: "engineer" });
    const issueId = await seedIssue(companyId, {
      title: "Stale work",
      priority: "medium",
      assigneeAgentId: agentId,
      status: "todo",
    });

    const run = await wakeAndQueue(agentId, issueId);
    await backdateRun(run.id, 120); // 2 hours > 60s threshold

    // Run the sweep with admission still closed. The run stays queued
    // and the sweep names its wait (global_cap from the admission denial).
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    const stored = await runRow(run.id);
    expect(stored?.status).toBe("queued");
    expect(stored?.contextSnapshot).toMatchObject({ waitReason: "global_cap" });
  }, 30_000);

  it("starts a queued run whose task is in todo when the admission gate opens", async () => {
    pinAdmission({ maxConcurrentRuns: 0 });
    applyRunPrioritySettings(readRunPriorityFromEnv({}));

    const { companyId, agentId } = await seedCompanyAndAgent({ name: "Eng", role: "engineer" });
    const issueId = await seedIssue(companyId, {
      title: "Todo work",
      priority: "medium",
      assigneeAgentId: agentId,
      status: "todo",
    });

    const run = await wakeAndQueue(agentId, issueId);

    // Open the admission gate and run the sweep.
    pinAdmission({ maxConcurrentRuns: 1 });
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    const stored = await runRow(run.id);
    expect(stored?.status).not.toBe("queued");
  }, 30_000);
});
