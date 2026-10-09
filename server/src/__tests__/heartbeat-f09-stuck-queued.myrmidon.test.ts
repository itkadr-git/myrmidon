// myrmidon(1.6.5 F-09): the stuck-queued sweep tests. A queued run whose task
// is in backlog is cancelled with `queued_run_issue_not_startable`; a queued
// run older than the explain threshold without waitReason gets one when a real
// denial was observed; a queued run older than the stall threshold raises a
// queue_stall attention card; a run whose task is in todo starts when the
// admission gate opens.
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  createDb,
  decisionQueueItems,
  decisionQueues,
  decisionTriageEvents,
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
import { subscribeCompanyLiveEvents } from "../services/live-events.ts";
import { attentionService } from "../services/attention.js";
import { decisionQueueService, type DecisionMutationActor } from "../services/decision-queues.js";
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

type SeedIssueInput = {
  title: string;
  priority: string;
  assigneeAgentId?: string;
  status?: string;
  hiddenAt?: Date | null;
};

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
    await db.delete(decisionQueueItems);
    await db.delete(decisionTriageEvents);
    await db.delete(decisionQueues);
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

  /** Issue seed shared by every case in this file: the two-argument form takes
   * an agent id (the F-09 card cases), the object form the full spec. */
  async function seedIssue(
    companyId: string,
    input: SeedIssueInput | string,
    overrides?: { status?: string; title?: string; priority?: string },
  ) {
    const spec: SeedIssueInput =
      typeof input === "string"
        ? {
            title: overrides?.title ?? "F-09 queued work",
            priority: overrides?.priority ?? "medium",
            assigneeAgentId: input,
            status: overrides?.status ?? "todo",
          }
        : input;
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: spec.title,
      status: spec.status ?? "todo",
      priority: spec.priority,
      assigneeAgentId: spec.assigneeAgentId ?? null,
      responsibleUserId: "responsible-user",
      hiddenAt: spec.hiddenAt ?? null,
    });
    return issueId;
  }

  /** Company without an agent: the F-09 card cases seed their own agent. */
  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    return companyId;
  }

  async function seedAgent(companyId: string, overrides: { adapterType?: string } = {}) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Eng",
      role: "engineer",
      status: "active",
      adapterType: overrides.adapterType ?? "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return agentId;
  }

  /** A run inserted straight into the queue, old enough for the stall sweep to
   * look at it: the card cases assert what the sweep writes, not what wakes it. */
  async function seedRun(companyId: string, agentId: string, issueId: string, status: string) {
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        issueId,
        invocationSource: "assignment",
        status,
        createdAt: new Date(Date.now() - 120 * MINUTE_MS),
      })
      .returning();
    return run!.id;
  }

  /** Board operator reading and mutating the decision shelves. */
  function boardActor(companyId: string) {
    return {
      type: "board" as const,
      source: "local_implicit" as const,
      userId: "board-user",
      companyIds: [companyId],
      isInstanceAdmin: false,
    };
  }

  function boardMutationActor(): DecisionMutationActor {
    return {
      actorType: "user",
      actorId: "board-user",
      agentId: null,
      userId: "board-user",
      runId: null,
      agentApiKeyId: null,
      responsibleUserId: "responsible-user",
    };
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

  /** The wait reason lives in the run's contextSnapshot, not in a column. */
  async function waitReasonOf(runId: string): Promise<string | null> {
    const row = await runRow(runId);
    const context = (row?.contextSnapshot ?? {}) as Record<string, unknown>;
    return typeof context.waitReason === "string" ? context.waitReason : null;
  }

  /** Queue a run behind a closed admission gate, then drop the gate's own
   * waitReason: the sweep case under test must be the one to name the wait. */
  async function queueUnexplainedRun(agentId: string, issueId: string, minutesAgo = 120) {
    pinAdmission({ maxConcurrentRuns: 0 });
    applyRunPrioritySettings(readRunPriorityFromEnv({}));
    const run = await wakeAndQueue(agentId, issueId);
    await db
      .update(heartbeatRuns)
      .set({ contextSnapshot: sql`${heartbeatRuns.contextSnapshot} - 'waitReason'` })
      .where(eq(heartbeatRuns.id, run.id));
    await backdateRun(run.id, minutesAgo);
    pinAdmission({ maxConcurrentRuns: 1 });
    expect(await waitReasonOf(run.id)).toBeNull();
    return run;
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

    // The sweep's cancellation is announced like every other run write.
    const cancelledEvents: Array<Record<string, unknown>> = [];
    const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      if (event.type === "heartbeat.run.status" && payload.runId === run.id && payload.status === "cancelled") {
        cancelledEvents.push(payload);
      }
    });

    // Open the admission gate and run the sweep.
    pinAdmission({ maxConcurrentRuns: 1 });
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    unsubscribe();
    expect(cancelledEvents).toHaveLength(1);
    expect(cancelledEvents[0]?.errorCode).toBe("queued_run_issue_not_startable");

    const stored = await runRow(run.id);
    expect(stored?.status).toBe("cancelled");
    expect(stored?.errorCode).toBe("queued_run_issue_not_startable");
    expect(stored?.error).toContain("backlog");
  }, 30_000);

  it("cancels a backlog queued run of an agent that has no free slot", async () => {
    // The agent sits at its concurrency ceiling: the early exit of the
    // per-agent pass must not keep a backlog run alive.
    pinAdmission({ maxConcurrentRuns: 5 });
    applyRunPrioritySettings(readRunPriorityFromEnv({}));

    const { companyId, agentId } = await seedCompanyAndAgent({ name: "Eng", role: "engineer" });
    const busyIssueId = await seedIssue(companyId, { title: "Busy work", priority: "medium", status: "todo" });
    const backlogIssueId = await seedIssue(companyId, {
      title: "Backlog work",
      priority: "medium",
      assigneeAgentId: agentId,
      status: "backlog",
    });
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "running",
      startedAt: new Date(),
      contextSnapshot: { issueId: busyIssueId },
    });
    const queued = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        invocationSource: "on_demand",
        triggerDetail: "manual",
        status: "queued",
        contextSnapshot: { issueId: backlogIssueId, wakeReason: "issue_assigned" },
      })
      .returning()
      .then((rows) => rows[0]!);

    await heartbeat.resumeQueuedRuns();

    const stored = await runRow(queued.id);
    expect(stored?.status).toBe("cancelled");
    expect(stored?.errorCode).toBe("queued_run_issue_not_startable");
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

  it("keeps waitReason null when the sweep never ran", async () => {
    // Red-side: the sweep must not fabricate a waitReason. A run that was
    // never processed by the sweep has no waitReason — the queue_stall card
    // (not a fake reason) surfaces it.
    applyRunPrioritySettings(readRunPriorityFromEnv({}));

    const { companyId, agentId } = await seedCompanyAndAgent({ name: "Eng", role: "engineer" });
    const issueId = await seedIssue(companyId, {
      title: "No sweep work",
      priority: "medium",
      assigneeAgentId: agentId,
      status: "todo",
    });

    // Create the run directly — bypass wakeup so startNextQueuedRunForAgent
    // is not called.
    const run = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        invocationSource: "on_demand",
        triggerDetail: "manual",
        status: "queued",
        contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      })
      .returning()
      .then((rows) => rows[0]!);
    await backdateRun(run.id, 120); // 2 hours > 60s explain threshold

    // Do NOT run the sweep. The waitReason must be null — no denial was
    // observed because the sweep never processed this run.
    const stored = await runRow(run.id);
    expect(stored?.status).toBe("queued");
    const context = stored?.contextSnapshot as Record<string, unknown> | null;
    expect(context?.waitReason ?? null).toBeNull();
  }, 30_000);

  it("raises a queue_stall attention card for a run older than the stall threshold", async () => {
    // A run queued longer than QUEUED_RUN_STALE_AFTER_SEC (default 3600s) with
    // no waitReason raises a queue_stall attention card.
    applyRunPrioritySettings(readRunPriorityFromEnv({}));

    const { companyId, agentId } = await seedCompanyAndAgent({ name: "Eng", role: "engineer" });
    const issueId = await seedIssue(companyId, {
      title: "Stall card work",
      priority: "medium",
      assigneeAgentId: agentId,
      status: "todo",
    });

    // Create the run directly — bypass wakeup so no gate denial is recorded.
    const run = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        invocationSource: "on_demand",
        triggerDetail: "manual",
        status: "queued",
        contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      })
      .returning()
      .then((rows) => rows[0]!);
    // Backdate past the stall threshold (default 3600s = 60 min).
    await backdateRun(run.id, 120); // 2 hours > 60 min stall threshold

    // The attention feed build scans for stalled runs and raises the card.
    const feed = await attentionService(db, { feedCacheTtlMs: 0 }).list(companyId, { userId: "board-user" });
    const card = feed.items.find((item) => item.sourceKind === "queue_stall");
    expect(card).toBeTruthy();
    expect(card?.subject.kind).toBe("run");
    expect(card?.subject.id).toBe(run.id);
    expect(card?.subject.metadata?.runId).toBe(run.id);
    expect(card?.subject.metadata?.agentId).toBe(agentId);
  }, 30_000);

  it("does not raise a queue_stall card for a run younger than the stall threshold", async () => {
    // A run queued for less than QUEUED_RUN_STALE_AFTER_SEC must NOT raise a
    // queue_stall card — it's not stalled yet.
    applyRunPrioritySettings(readRunPriorityFromEnv({}));

    const { companyId, agentId } = await seedCompanyAndAgent({ name: "Eng", role: "engineer" });
    const issueId = await seedIssue(companyId, {
      title: "Fresh work",
      priority: "medium",
      assigneeAgentId: agentId,
      status: "todo",
    });

    // Create the run directly — bypass wakeup so no gate denial is recorded.
    await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        invocationSource: "on_demand",
        triggerDetail: "manual",
        status: "queued",
        contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      })
      .returning()
      .then((rows) => rows[0]!);
    // Do NOT backdate — the run is fresh (< stall threshold).

    // The attention feed build scans for stalled runs — none should appear.
    const feed = await attentionService(db, { feedCacheTtlMs: 0 }).list(companyId, { userId: "board-user" });
    const card = feed.items.find((item) => item.sourceKind === "queue_stall");
    expect(card).toBeUndefined();
  }, 30_000);

  it("clears the queue_stall card once the run starts", async () => {
    // When a stalled run finally starts, its queue_stall card must disappear
    // from the attention feed.
    const { companyId, agentId } = await seedCompanyAndAgent({ name: "Eng", role: "engineer" });
    const issueId = await seedIssue(companyId, {
      title: "Clears card work",
      priority: "medium",
      assigneeAgentId: agentId,
      status: "todo",
    });

    // A real queued run (woken through the regular path), held by a closed
    // gate, aged past the stall threshold and left without a waitReason.
    const run = await queueUnexplainedRun(agentId, issueId);

    // The card should be present — the run is stalled with no waitReason.
    let feed = await attentionService(db, { feedCacheTtlMs: 0 }).list(companyId, { userId: "board-user" });
    let card = feed.items.find((item) => item.sourceKind === "queue_stall");
    expect(card).toBeTruthy();

    // Open the gate and run the sweep — the run starts.
    pinAdmission({ maxConcurrentRuns: 1 });
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    const stored = await runRow(run.id);
    expect(stored?.status).not.toBe("queued");

    // Card should be gone — the run is no longer queued.
    feed = await attentionService(db, { feedCacheTtlMs: 0 }).list(companyId, { userId: "board-user" });
    card = feed.items.find((item) => item.sourceKind === "queue_stall");
    expect(card).toBeUndefined();
  }, 30_000);

  it("marks queued runs with maintenance when the agent is under a maintenance window", async () => {
    const { newWindow } = await import("../myrmidon/maintenance/domain.js");
    const { setMaintenanceDocumentCache, resetMaintenanceGateCaches } = await import(
      "../myrmidon/maintenance/gate.js"
    );
    const { companyId, agentId } = await seedCompanyAndAgent({ name: "Eng", role: "engineer" });
    const issueId = await seedIssue(companyId, {
      title: "Maintenance test",
      priority: "medium",
      assigneeAgentId: agentId,
      status: "todo",
    });
    const run = await queueUnexplainedRun(agentId, issueId);
    try {
      // Set an instance-scoped maintenance window in the "on" state.
      const window = newWindow({
        id: randomUUID(),
        scope: { type: "instance" },
        companyId: null,
        reason: "test",
        drainTimeoutSec: 0,
        onTimeout: "cancel",
        startedBy: null,
        now: new Date(),
      });
      window.state = "on";
      setMaintenanceDocumentCache({ version: 1, windows: [window], history: [] });

      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
      const stored = await runRow(run.id);
      expect(stored?.status).toBe("queued");
      expect(await waitReasonOf(run.id)).toBe("maintenance");
    } finally {
      resetMaintenanceGateCaches();
      await heartbeat.drainActiveRunExecutions();
    }
  }, 30_000);

  it("marks queued runs with agent_not_invokable when the agent is paused", async () => {
    const { companyId } = await seedCompanyAndAgent({ name: "Eng", role: "engineer" });
    const [agent] = await db
      .insert(agents)
      .values({
        id: randomUUID(),
        companyId,
        name: "Paused Agent",
        role: "engineer",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
        status: "active",
      })
      .returning();
    const issueId = await seedIssue(companyId, {
      title: "Agent not invokable test",
      priority: "medium",
      assigneeAgentId: agent.id,
      status: "todo",
    });
    const run = await queueUnexplainedRun(agent.id, issueId);
    try {
      // A paused agent is not invokable, but its queue is kept (only a
      // terminated agent or a broken org chain cancels the queued runs).
      await db.update(agents).set({ status: "paused" }).where(eq(agents.id, agent.id));
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
      const stored = await runRow(run.id);
      expect(stored?.status).toBe("queued");
      expect(await waitReasonOf(run.id)).toBe("agent_not_invokable");
    } finally {
      await heartbeat.drainActiveRunExecutions();
    }
  }, 30_000);

  it("marks queued runs with scheduling_suppressed when scheduling is suppressed", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ name: "Eng", role: "engineer" });
    const issueId = await seedIssue(companyId, {
      title: "Scheduling suppressed test",
      priority: "medium",
      assigneeAgentId: agentId,
      status: "todo",
    });
    const run = await queueUnexplainedRun(agentId, issueId);
    const originalEnv = process.env.PAPERCLIP_IN_WORKTREE;
    try {
      process.env.PAPERCLIP_IN_WORKTREE = "1";
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
      const stored = await runRow(run.id);
      expect(stored?.status).toBe("queued");
      expect(await waitReasonOf(run.id)).toBe("scheduling_suppressed");
    } finally {
      if (originalEnv === undefined) {
        delete process.env.PAPERCLIP_IN_WORKTREE;
      } else {
        process.env.PAPERCLIP_IN_WORKTREE = originalEnv;
      }
      await heartbeat.drainActiveRunExecutions();
    }
  }, 30_000);

  it("canReadDecisionSource resolves queue_stall with run id", async () => {
    const { canReadDecisionSource } = await import("../services/decision-queues.js");
    const { companyId, agentId } = await seedCompanyAndAgent({ name: "Eng", role: "engineer" });
    const issueId = await seedIssue(companyId, {
      title: "Decision source test",
      priority: "medium",
      assigneeAgentId: agentId,
      status: "todo",
    });
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        issueId,
        invocationSource: "assignment",
        status: "queued",
      })
      .returning();

    // The decision queue must find the run by sourceId (run id).
    const result = await canReadDecisionSource(
      db,
      boardActor(companyId),
      companyId,
      "queue_stall",
      run.id,
    );
    expect(result).toBe(true);
  }, 30_000);

  it("canReadDecisionSource returns false for a queue_stall with a non-run id", async () => {
    const { canReadDecisionSource } = await import("../services/decision-queues.js");
    const { companyId, agentId } = await seedCompanyAndAgent({ name: "Eng", role: "engineer" });
    const issueId = await seedIssue(companyId, {
      title: "Decision source negative test",
      priority: "medium",
      assigneeAgentId: agentId,
      status: "todo",
    });

    // A task id should NOT resolve as a queue_stall source (source is the run).
    const result = await canReadDecisionSource(
      db,
      boardActor(companyId),
      companyId,
      "queue_stall",
      issueId,
    );
    expect(result).toBe(false);
  }, 30_000);

  it("keeps a queue_stall card keyed by the run id when the board keeps it", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const issueId = await seedIssue(companyId, agentId, { status: "todo" });
    const runId = await seedRun(companyId, agentId, issueId, "queued");
    const board = boardActor(companyId);
    const actor = boardMutationActor();
    const queues = decisionQueueService(db);
    await queues.create({ companyId, key: "stall-triage", title: "Stall triage", authActor: board, actor });

    const added = await queues.addItem({
      companyId,
      key: "stall-triage",
      sourceKind: "queue_stall",
      sourceId: runId,
      authActor: board,
      actor,
    });
    // Red without the queue_stall branch of the source resolver: the card is
    // filed by run id, so an unresolved run makes addItem throw notFound.
    expect(added.created).toBe(true);

    // «Оставить»: the card stays on the shelf keyed by the run, and the
    // decision itself must not touch the queued run.
    const kept = await queues.listItems(companyId, "stall-triage", board);
    expect(kept.map((item) => item.sourceId)).toEqual([runId]);
    expect(kept[0]?.sourceKind).toBe("queue_stall");

    const stored = await runRow(runId);
    expect(stored?.status).toBe("queued");
    expect(await waitReasonOf(runId)).toBeNull();
  }, 30_000);

  it("archives a queue_stall card by run id and audits the removal against the run", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const issueId = await seedIssue(companyId, agentId, { status: "todo" });
    const runId = await seedRun(companyId, agentId, issueId, "queued");
    const board = boardActor(companyId);
    const actor = boardMutationActor();
    const queues = decisionQueueService(db);
    await queues.create({ companyId, key: "stall-triage", title: "Stall triage", authActor: board, actor });
    await queues.addItem({
      companyId,
      key: "stall-triage",
      sourceKind: "queue_stall",
      sourceId: runId,
      authActor: board,
      actor,
    });

    // «В архив»: the card leaves the shelf, and both audit trails record the
    // run id — not the issue id — as the thing that was decided about.
    const removed = await queues.removeItem({
      companyId,
      key: "stall-triage",
      sourceKind: "queue_stall",
      sourceId: runId,
      reason: "archived from the stall card",
      authActor: board,
      actor,
    });
    expect(removed.sourceId).toBe(runId);
    expect(await queues.listItems(companyId, "stall-triage", board)).toEqual([]);

    const triageEvents = await db
      .select()
      .from(decisionTriageEvents)
      .where(and(eq(decisionTriageEvents.sourceKind, "queue_stall"), eq(decisionTriageEvents.sourceId, runId)));
    expect(triageEvents.map((event) => event.action).sort()).toEqual(["queue_item.added", "queue_item.removed"]);

    const audited = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "decision_queue_item.removed"));
    expect(audited[0]?.details).toMatchObject({ sourceKind: "queue_stall", sourceId: runId });

    // Archiving the card is not a verdict on the run: the run stays queued.
    const stored = await runRow(runId);
    expect(stored?.status).toBe("queued");
    expect(await waitReasonOf(runId)).toBeNull();
  }, 30_000);
});
