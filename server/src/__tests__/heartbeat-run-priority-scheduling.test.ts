// myrmidon(1.6.5 RUN-PRIORITY A): when run admission is closed the queue must
// start reviews, releases and current-release work first, in both sweeps: the
// global resumeQueuedRuns sweep (formerly a pure createdAt FIFO) and the
// per-agent startNextQueuedRunForAgent comparator. Aging must pull a starved
// run over a higher-priority one, and a weights change applied through the
// settings service must reorder the very next sweep without a restart.
// Admission limits themselves are unchanged — only the choice order inside
// the admitted slots is under test.
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
} from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  readRunPriorityFromEnv,
  type RunPrioritySettings,
} from "@myrmidon/shared";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";
import {
  applyRunAdmissionLimits,
  currentRunAdmissionLimits,
  resetSharedRunAdmissionForTests,
  type RunAdmissionLimits,
} from "../myrmidon/run-admission.js";
import {
  applyCompanyReleaseFocus,
  applyRunPrioritySettings,
  currentRunPrioritySettings,
  resetRunPriorityForTests,
} from "../myrmidon/run-priority/state.js";
import { runPriorityService } from "../myrmidon/run-priority/service.js";
import { advanceFocusDeferredRuns } from "../myrmidon/run-priority/sync.js";
import { registerSettingsAppliers } from "../myrmidon/settings-appliers/index.js";
import { strictReleaseFocusRelease } from "../myrmidon/release-focus.js";
import { createDiskBudgetGate } from "../myrmidon/disk-budget/disk-budget.js";
import { setDiskBudgetGateForTests } from "../myrmidon/disk-budget/disk-budget-wiring.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Run-priority heartbeat test run.",
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
    `Skipping embedded Postgres heartbeat run-priority scheduling tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
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

/** The env-free built-in defaults, so a host MYRMIDON_RUN_PRIORITY_* cannot leak. */
function defaultSettings(): RunPrioritySettings {
  return readRunPriorityFromEnv({});
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

describeEmbeddedPostgres("heartbeat run-priority queued run selection", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-run-priority-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    await ensureIssueRelationsTable(db);
  }, 120_000);

  afterEach(async () => {
    await heartbeat.drainActiveRunExecutions();
    setDiskBudgetGateForTests(null);
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
      summary: "Run-priority heartbeat test run.",
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
    input: { title: string; priority: string; assigneeAgentId?: string },
  ) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: input.title,
      status: "todo",
      priority: input.priority,
      assigneeAgentId: input.assigneeAgentId ?? null,
      responsibleUserId: "responsible-user",
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

  it("global sweep starts the review agent's newer queued run before an older engineer run", async () => {
    pinAdmission({ maxConcurrentRuns: 0 });
    applyRunPrioritySettings(defaultSettings());

    const review = await seedCompanyAndAgent({ name: "Reviewer", role: "review" });
    const engineer = await seedCompanyAndAgent({ name: "Engineer", role: "engineer" });
    const reviewIssueId = await seedIssue(review.companyId, {
      title: "Review the priority patch",
      priority: "medium",
      assigneeAgentId: review.agentId,
    });
    const engineerIssueId = await seedIssue(engineer.companyId, {
      title: "Engineer work",
      priority: "medium",
      assigneeAgentId: engineer.agentId,
    });

    // FIFO would start the engineer: its run waits from the older createdAt.
    const engineerRun = await wakeAndQueue(engineer.agentId, engineerIssueId);
    const reviewRun = await wakeAndQueue(review.agentId, reviewIssueId);

    pinAdmission({ maxConcurrentRuns: 1 });
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    const startedReview = await runRow(reviewRun.id);
    const stillQueued = await runRow(engineerRun.id);
    expect(startedReview?.status).not.toBe("queued");
    expect(stillQueued?.status).toBe("queued");
    expect(stillQueued.contextSnapshot).toMatchObject({
      waitReason: "global_cap",
      queuePosition: 2,
      queueLength: 2,
    });
    // the same pass told every waiting run where it stood (the review run was
    // rank 1 of 2) and the claim that started it dropped the note again
    expect(startedReview?.contextSnapshot).not.toHaveProperty("queuePosition");
    expect(startedReview?.contextSnapshot).not.toHaveProperty("waitReason");
  }, 30_000);

  // myrmidon(RESUME-QUEUE-AGE): the sweep's service keys (wait reason, queue
  // position, queue length) are merged on the database side, so a key written to
  // the run's context by someone else (the resume stamp) survives them.
  it("keeps the resume stamp of a queued run when the sweep writes its wait reason and position", async () => {
    pinAdmission({ maxConcurrentRuns: 0 });
    applyRunPrioritySettings(defaultSettings());

    const review = await seedCompanyAndAgent({ name: "StampReviewer", role: "review" });
    const engineer = await seedCompanyAndAgent({ name: "StampEngineer", role: "engineer" });
    const reviewIssueId = await seedIssue(review.companyId, {
      title: "Review", priority: "medium", assigneeAgentId: review.agentId,
    });
    const engineerIssueId = await seedIssue(engineer.companyId, {
      title: "Work", priority: "medium", assigneeAgentId: engineer.agentId,
    });
    const engineerRun = await wakeAndQueue(engineer.agentId, engineerIssueId);
    await wakeAndQueue(review.agentId, reviewIssueId);
    const stamp = Date.now() - 1000;
    await db
      .update(heartbeatRuns)
      .set({ contextSnapshot: sql`${heartbeatRuns.contextSnapshot} || jsonb_build_object('queueWaitResumedAtMs', ${stamp}::bigint)` })
      .where(eq(heartbeatRuns.id, engineerRun.id));

    pinAdmission({ maxConcurrentRuns: 1 });
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    const stillQueued = await runRow(engineerRun.id);
    expect(stillQueued?.status).toBe("queued");
    expect(stillQueued.contextSnapshot).toMatchObject({
      waitReason: "global_cap", queuePosition: 2, queueLength: 2, queueWaitResumedAtMs: stamp,
    });
  }, 30_000);

  it("keeps the role in front of the issue priority: the review run starts before an older critical engineer run", async () => {
    applyRunPrioritySettings(defaultSettings());
    pinAdmission({ maxConcurrentRuns: 0 });

    const review = await seedCompanyAndAgent({ name: "RoleReviewer", role: "review" });
    const engineer = await seedCompanyAndAgent({ name: "CriticalEngineer", role: "engineer" });
    const reviewIssueId = await seedIssue(review.companyId, {
      title: "Review a low-priority patch",
      priority: "low",
      assigneeAgentId: review.agentId,
    });
    const engineerIssueId = await seedIssue(engineer.companyId, {
      title: "Critical engineer work",
      priority: "critical",
      assigneeAgentId: engineer.agentId,
    });

    const engineerRun = await wakeAndQueue(engineer.agentId, engineerIssueId);
    const reviewRun = await wakeAndQueue(review.agentId, reviewIssueId);
    // The engineer run is OLDER, carries the heavier issue and has spent the
    // whole pre-escape aging budget (89 minutes = 8 steps of 5). Under the old
    // max(role, issue) weight it scored 100 + 40 against the review run's 90 and
    // took the slot; the banded weight keeps it inside its own band.
    await backdateRun(engineerRun.id, 89);

    pinAdmission({ maxConcurrentRuns: 1 });
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    const startedReview = await runRow(reviewRun.id);
    const stillQueued = await runRow(engineerRun.id);
    expect(startedReview?.status).not.toBe("queued");
    expect(stillQueued?.status).toBe("queued");
    // the run that lost the slot says why, and where it waited
    expect(stillQueued.contextSnapshot).toMatchObject({ queuePosition: 2, queueLength: 2 });
  }, 30_000);

  it("no longer hands the slot to a starved run whose task is less important than a fresh run's", async () => {
    applyRunPrioritySettings(defaultSettings());
    pinAdmission({ maxConcurrentRuns: 0 });

    const review = await seedCompanyAndAgent({ name: "StarvedReviewer", role: "review" });
    const engineer = await seedCompanyAndAgent({ name: "StarvedEngineer", role: "engineer" });
    const reviewIssueId = await seedIssue(review.companyId, {
      title: "Fresh review work",
      priority: "low",
      assigneeAgentId: review.agentId,
    });
    const engineerIssueId = await seedIssue(engineer.companyId, {
      title: "Starved engineer work",
      priority: "none",
      assigneeAgentId: engineer.agentId,
    });

    const engineerRun = await wakeAndQueue(engineer.agentId, engineerIssueId);
    const reviewRun = await wakeAndQueue(review.agentId, reviewIssueId);
    // myrmidon(1.6.5 RUN-PRIORITY-PICK): past the 90-minute limit the escape is
    // a lift inside the starved run's own importance step — it no longer
    // outranks the role bands, so the fresh review run, whose task (low) is more
    // important than the starved one (none), keeps the slot.
    await backdateRun(engineerRun.id, 91);

    pinAdmission({ maxConcurrentRuns: 1 });
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    const startedReview = await runRow(reviewRun.id);
    const stillQueued = await runRow(engineerRun.id);
    expect(startedReview?.status).not.toBe("queued");
    expect(stillQueued?.status).toBe("queued");
  }, 30_000);

  it("global sweep starts the current-release labeled run first, ahead of an older FIFO run", async () => {
    pinAdmission({ maxConcurrentRuns: 0 });
    // Aging off: the release bonus is the only difference between the runs.
    const settings = {
      ...defaultSettings(),
      currentRelease: "1.6.5-rc.6",
      agingStepMinutes: 0,
      starvationLimitMinutes: 0,
    };
    applyRunPrioritySettings(settings);

    const plain = await seedCompanyAndAgent({ name: "PlainEng", role: "engineer" });
    const release = await seedCompanyAndAgent({ name: "ReleaseEng", role: "engineer" });
    const plainIssueId = await seedIssue(plain.companyId, {
      title: "Plain work",
      priority: "medium",
      assigneeAgentId: plain.agentId,
    });
    const releaseIssueId = await seedIssue(release.companyId, {
      title: "Cut the release",
      priority: "medium",
      assigneeAgentId: release.agentId,
    });
    const labelId = randomUUID();
    await db.insert(labels).values({
      id: labelId,
      companyId: release.companyId,
      name: "1.6.5-rc.6",
      color: "#888888",
    });
    await db.insert(issueLabels).values({
      issueId: releaseIssueId,
      labelId,
      companyId: release.companyId,
    });

    // Plain is OLDER (pure FIFO would start it first); both carry a medium
    // issue on the engineer role, but the release label lifts the release run a
    // whole lane above every role, so it takes the single slot.
    const plainRun = await wakeAndQueue(plain.agentId, plainIssueId);
    const releaseRun = await wakeAndQueue(release.agentId, releaseIssueId);
    await backdateRun(plainRun.id, 25);

    pinAdmission({ maxConcurrentRuns: 1 });
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    const startedRelease = await runRow(releaseRun.id);
    const stillQueued = await runRow(plainRun.id);
    expect(startedRelease?.status).not.toBe("queued");
    expect(stillQueued?.status).toBe("queued");
    // the run left waiting knows its place in the same pass's order
    expect(stillQueued.contextSnapshot).toMatchObject({ queuePosition: 2, queueLength: 2 });
  }, 30_000);

  it("per-agent sweep lets an aged medium run overtake a fresh high run", async () => {
    // Aging on, starvation escape off: only the waiting bonus decides.
    const settings = { ...defaultSettings(), starvationLimitMinutes: 0 };
    applyRunPrioritySettings(settings);
    pinAdmission({ maxConcurrentRuns: 0 });

    const { companyId, agentId } = await seedCompanyAndAgent({
      name: "SoloEngineer",
      role: "engineer",
    });
    const highIssueId = await seedIssue(companyId, {
      title: "Fresh high work",
      priority: "high",
      assigneeAgentId: agentId,
    });
    const mediumIssueId = await seedIssue(companyId, {
      title: "Starved medium work",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const mediumRun = await wakeAndQueue(agentId, mediumIssueId);
    const highRun = await wakeAndQueue(agentId, highIssueId);
    // The medium run spent 35 of the 50 aging points (7 steps of 5) on top of
    // the medium issue, so it lands at 60 + 35 = 95 inside the engineer band
    // while the fresh high one is 80. The old per-agent comparator (rank
    // -> issue priority -> createdAt) would start the high run first despite
    // the medium run waiting fourteen times longer.
    await backdateRun(mediumRun.id, 70);
    await backdateRun(highRun.id, 5);

    pinAdmission({ maxConcurrentRuns: 1 });
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    const startedMedium = await runRow(mediumRun.id);
    const stillQueued = await runRow(highRun.id);
    expect(startedMedium?.status).not.toBe("queued");
    expect(stillQueued?.status).toBe("queued");
  }, 30_000);

  it("per-agent sweep keeps issue priority order inside a lead agent: the high run starts before the older low run", async () => {
    // The lead role opens one band; the high(80) and low(40) issues order
    // inside it, so the high run starts despite the low run being older.
    applyRunPrioritySettings(defaultSettings());
    pinAdmission({ maxConcurrentRuns: 0 });

    const { companyId, agentId } = await seedCompanyAndAgent({
      name: "SoloLead",
      role: "lead",
    });
    const lowIssueId = await seedIssue(companyId, {
      title: "Old low work",
      priority: "low",
      assigneeAgentId: agentId,
    });
    const highIssueId = await seedIssue(companyId, {
      title: "Newer high work",
      priority: "high",
      assigneeAgentId: agentId,
    });

    const lowRun = await wakeAndQueue(agentId, lowIssueId);
    const highRun = await wakeAndQueue(agentId, highIssueId);
    // Same aging step (< 10 min), the low run is the older one.
    await backdateRun(lowRun.id, 4);
    await backdateRun(highRun.id, 2);

    pinAdmission({ maxConcurrentRuns: 1 });
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    const startedHigh = await runRow(highRun.id);
    const stillQueued = await runRow(lowRun.id);
    expect(startedHigh?.status).not.toBe("queued");
    expect(stillQueued?.status).toBe("queued");
  }, 30_000);

  // myrmidon(OPE-13231): strict release focus at the run-start gate.
  async function seedFocusScenario(strict: boolean) {
    pinAdmission({ maxConcurrentRuns: 0 });
    const { companyId, agentId } = await seedCompanyAndAgent({ name: "Engineer", role: "engineer" });
    applyCompanyReleaseFocus(new Map([[companyId, { currentRelease: "1.6.9", strictReleaseFocus: strict }]]));
    const colleague = randomUUID();
    await db.insert(agents).values({
      id: colleague, companyId, name: "Colleague", role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    // The engineer has only a 1.8 task; the 1.6.9 task belongs to a colleague.
    const otherIssueId = await seedIssue(companyId, { title: "1.8 work", priority: "medium", assigneeAgentId: agentId });
    const currentIssueId = await seedIssue(companyId, { title: "1.6.9 work", priority: "medium", assigneeAgentId: colleague });
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, otherIssueId));
    for (const [issueId, name] of [[otherIssueId, "1.8"], [currentIssueId, "1.6.9"]] as const) {
      const labelId = randomUUID();
      await db.insert(labels).values({ id: labelId, companyId, name, color: "#ffffff" });
      await db.insert(issueLabels).values({ issueId, labelId, companyId });
    }
    return { companyId, agentId, otherIssueId, currentIssueId };
  }

  async function commentWake(agentId: string, issueId: string) {
    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId },
      contextSnapshot: { issueId, wakeReason: "issue_commented" },
    });
    expect(run).not.toBeNull();
    return run!;
  }

  async function sweep() {
    pinAdmission({ maxConcurrentRuns: 1 });
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
  }

  it("strict focus: a comment wake on a 1.8 task of an engineer without own 1.6.9 work is deferred, not lost", async () => {
    const { agentId, otherIssueId } = await seedFocusScenario(true);
    const run = await commentWake(agentId, otherIssueId);
    await sweep();
    const row = await runRow(run.id);
    expect(row?.status).toBe("scheduled_retry");
    expect(row?.scheduledRetryAt).not.toBeNull();
    expect(JSON.stringify(row?.contextSnapshot)).toContain("releaseFocusDeferral");
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("strict focus: a queued continuation or retry of a 1.8 task that bypassed the wake path does not start", async () => {
    const { companyId, agentId, otherIssueId } = await seedFocusScenario(true);
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, status: "queued", invocationSource: "automation",
      contextSnapshot: { issueId: otherIssueId, wakeReason: "max_turn_continuation" },
    });
    await sweep();
    expect((await runRow(runId))?.status).toBe("scheduled_retry");
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("strict focus: the deferred run starts after the flag is switched off, without a restart", async () => {
    const { companyId, agentId, otherIssueId } = await seedFocusScenario(true);
    const run = await commentWake(agentId, otherIssueId);
    await sweep();
    expect((await runRow(run.id))?.status).toBe("scheduled_retry");
    applyCompanyReleaseFocus(new Map([[companyId, { currentRelease: "1.6.9", strictReleaseFocus: false }]]));
    await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(Date.now() - 1000) }).where(eq(heartbeatRuns.id, run.id));
    await heartbeat.promoteDueScheduledRetries();
    await sweep();
    expect(mockAdapterExecute).toHaveBeenCalled();
    expect(["running", "succeeded"]).toContain((await runRow(run.id))?.status);
  });

  const actorUser = { actorType: "user" as const, actorId: "responsible-user", agentId: null, runId: null, agentApiKeyId: null };

  it("strict focus: lifting the focus makes the deferred runs due at once, no waiting for the recheck ladder", async () => {
    const { companyId, agentId, otherIssueId } = await seedFocusScenario(true);
    const run = await commentWake(agentId, otherIssueId);
    await sweep();
    const parked = await runRow(run.id);
    expect(parked?.status).toBe("scheduled_retry");
    // The ladder parks it well into the future.
    expect(parked!.scheduledRetryAt!.getTime()).toBeGreaterThan(Date.now() + 30_000);

    const service = runPriorityService(db, {
      env: {},
      advanceDeferredRuns: () => advanceFocusDeferredRuns(db),
    });
    await service.updateCompany(companyId, { currentRelease: "1.6.9", strictReleaseFocus: false }, actorUser);
    expect((await runRow(run.id))!.scheduledRetryAt!.getTime()).toBeLessThanOrEqual(Date.now());

    await heartbeat.promoteDueScheduledRetries();
    await sweep();
    expect(mockAdapterExecute).toHaveBeenCalled();
    expect(["running", "succeeded"]).toContain((await runRow(run.id))?.status);
  }, 30_000);

  it("only runs parked by the focus are advanced; a failed run's retry that copied the key keeps its real backoff", async () => {
    const { companyId, agentId, otherIssueId } = await seedFocusScenario(true);
    const parkedByFocus = await commentWake(agentId, otherIssueId);
    await sweep();
    const focusRow = await runRow(parkedByFocus.id);
    expect(focusRow?.status).toBe("scheduled_retry");

    // A retry of a failed run: the context (with the deferral key of the
    // original) is copied, the due time is its own backoff.
    const backoffAt = new Date(Date.now() + 10 * MINUTE_MS);
    const retryId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: retryId, companyId, agentId, status: "scheduled_retry", invocationSource: "automation",
      scheduledRetryAt: backoffAt, scheduledRetryReason: "transient_upstream_failure",
      contextSnapshot: {
        issueId: otherIssueId,
        releaseFocusDeferral: { count: 1, firstDeferredAt: new Date().toISOString(), deferredAt: new Date().toISOString(), dueAt: new Date(Date.now() - 60_000).toISOString() },
      },
    });

    const advanced = await advanceFocusDeferredRuns(db);
    expect(advanced).toBe(1);
    expect((await runRow(parkedByFocus.id))!.scheduledRetryAt!.getTime()).toBeLessThanOrEqual(Date.now());
    expect((await runRow(retryId))!.scheduledRetryAt!.getTime()).toBe(backoffAt.getTime());
  }, 30_000);

  it("strict focus: a change of the current release advances the deferred runs too; an unrelated change does not", async () => {
    const { companyId, agentId, otherIssueId } = await seedFocusScenario(true);
    const run = await commentWake(agentId, otherIssueId);
    await sweep();
    const parkedAt = (await runRow(run.id))!.scheduledRetryAt!.getTime();
    const service = runPriorityService(db, {
      env: {},
      advanceDeferredRuns: () => advanceFocusDeferredRuns(db),
    });
    await service.update({ roleWeights: { ...defaultSettings().roleWeights, engineer: 123 } }, actorUser);
    expect((await runRow(run.id))!.scheduledRetryAt!.getTime()).toBe(parkedAt);
    await service.updateCompany(companyId, { currentRelease: "1.7", strictReleaseFocus: true }, actorUser);
    expect((await runRow(run.id))!.scheduledRetryAt!.getTime()).toBeLessThanOrEqual(Date.now());
  }, 30_000);

  it("another process sees a saved focus change through the settings_changed path, not through a direct apply", async () => {
    const handlers: Array<(payload: unknown) => void> = [];
    const bus = {
      publish: async (_channel: "settings_changed", payload: unknown) => {
        for (const handler of handlers) handler(payload);
      },
      subscribe: <T,>(_channel: "settings_changed", handler: (payload: T) => void) => {
        handlers.push(handler as (payload: unknown) => void);
        return () => undefined;
      },
    };
    // The "other process": it listens on the bus and keeps its own memory.
    registerSettingsAppliers(bus, { db: db as never });
    const { companyId } = await seedFocusScenario(true);
    expect(strictReleaseFocusRelease(companyId)).toBe("1.6.9");

    // The writing process: its own apply never touches this memory.
    const writer = runPriorityService(db, {
      env: {},
      // The writing process applies the stored row to ITS memory; keep ours untouched.
      applyStored: async () => ({ ...defaultSettings(), currentRelease: "1.6.9", strictReleaseFocus: false }),
      publishChanged: () => bus.publish("settings_changed", { changedKeys: ["runPriority"] }),
    });
    await writer.updateCompany(companyId, { currentRelease: "1.6.9", strictReleaseFocus: false }, actorUser);
    await vi.waitFor(() => expect(strictReleaseFocusRelease(companyId)).toBeNull());

    await writer.updateCompany(companyId, { strictReleaseFocus: true, currentRelease: "1.7" }, actorUser);
    await vi.waitFor(() => expect(strictReleaseFocusRelease(companyId)).toBe("1.7"));
  }, 30_000);

  it("strict focus: the deferred run starts once no open current-release task is left", async () => {
    const { agentId, otherIssueId, currentIssueId } = await seedFocusScenario(true);
    const run = await commentWake(agentId, otherIssueId);
    await sweep();
    expect((await runRow(run.id))?.status).toBe("scheduled_retry");
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, currentIssueId));
    await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(Date.now() - 1000) }).where(eq(heartbeatRuns.id, run.id));
    await heartbeat.promoteDueScheduledRetries();
    await sweep();
    expect(mockAdapterExecute).toHaveBeenCalled();
  });

  it("flag off: the 1.8 wake runs as before focus", async () => {
    const off = await seedFocusScenario(false);
    const offRun = await commentWake(off.agentId, off.otherIssueId);
    await sweep();
    expect(["running", "succeeded"]).toContain((await runRow(offRun.id))?.status);
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
  });

  it("strict focus: a run of a current-release task starts", async () => {
    const { currentIssueId } = await seedFocusScenario(true);
    const colleague = (await db.select({ a: issues.assigneeAgentId }).from(issues).where(eq(issues.id, currentIssueId)))[0]!.a!;
    const run = await commentWake(colleague, currentIssueId);
    await sweep();
    expect(["running", "succeeded"]).toContain((await runRow(run.id))?.status);
  });

  async function dueCycle(runId: string) {
    await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(Date.now() - 1000) }).where(eq(heartbeatRuns.id, runId));
    await heartbeat.promoteDueScheduledRetries();
    await sweep();
  }

  async function runEventCount(runId: string) {
    return (await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId))).length;
  }

  it("strict focus: repeated rechecks add no events, keep the retry attempt, free the lock and wake nobody", async () => {
    const { agentId, otherIssueId } = await seedFocusScenario(true);
    const run = await commentWake(agentId, otherIssueId);
    const wakesBefore = (await db.select().from(agentWakeupRequests)).length;
    await sweep();
    const first = await runRow(run.id);
    expect(first?.status).toBe("scheduled_retry");
    // The first deferral wakes nobody either.
    expect((await db.select().from(agentWakeupRequests)).length).toBe(wakesBefore);
    const eventsAfterFirst = await runEventCount(run.id);
    const wakesAfterFirst = (await db.select().from(agentWakeupRequests)).length;
    const attempt = first?.scheduledRetryAttempt;
    const dueAfterFirst = first!.scheduledRetryAt!.getTime() - Date.now();
    for (let i = 0; i < 4; i += 1) await dueCycle(run.id);
    const later = await runRow(run.id);
    expect(later?.status).toBe("scheduled_retry");
    expect(later?.scheduledRetryAttempt).toBe(attempt);
    expect(await runEventCount(run.id)).toBe(eventsAfterFirst);
    expect((await db.select().from(agentWakeupRequests)).length).toBe(wakesAfterFirst);
    const issue = await db.select().from(issues).where(eq(issues.id, otherIssueId)).then((rows) => rows[0]!);
    expect(issue.executionRunId).not.toBe(run.id);
    // The recheck interval grows: 2 min first, 30 min after four rechecks.
    expect(dueAfterFirst).toBeLessThanOrEqual(2 * MINUTE_MS);
    expect(later!.scheduledRetryAt!.getTime() - Date.now()).toBeGreaterThan(20 * MINUTE_MS);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("strict focus: a deferred run of a non-assignee (comment or mention) survives rechecks and starts after focus is lifted", async () => {
    const { companyId, otherIssueId } = await seedFocusScenario(true);
    const mentioned = randomUUID();
    await db.insert(agents).values({
      id: mentioned, companyId, name: "Mentioned", role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {},
    });
    const run = await commentWake(mentioned, otherIssueId);
    await sweep();
    await dueCycle(run.id);
    await dueCycle(run.id);
    expect((await runRow(run.id))?.status).toBe("scheduled_retry");
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    applyCompanyReleaseFocus(new Map([[companyId, { currentRelease: "1.6.9", strictReleaseFocus: false }]]));
    await dueCycle(run.id);
    // The queued-run staleness gate must not cancel the non-assignee run as a reassignment.
    const finalRow = await runRow(run.id);
    expect({ status: finalRow?.status, errorCode: finalRow?.errorCode }).toEqual({ status: expect.stringMatching(/^(running|succeeded)$/), errorCode: null });
    expect(mockAdapterExecute).toHaveBeenCalled();
  });

  it("strict focus: a review the agent participates in runs without delay", async () => {
    const { agentId, otherIssueId } = await seedFocusScenario(true);
    await db.update(issues).set({
      status: "in_review",
      executionState: { currentParticipant: { type: "agent", agentId } },
    }).where(eq(issues.id, otherIssueId));
    const run = await commentWake(agentId, otherIssueId);
    await sweep();
    expect(["running", "succeeded"]).toContain((await runRow(run.id))?.status);
  });

  it("strict focus: an owner-assigned task and a manual user wake run without delay", async () => {
    const { companyId, agentId, otherIssueId } = await seedFocusScenario(true);
    await db.insert(activityLog).values({
      companyId, entityType: "issue", entityId: otherIssueId, actorType: "user", actorId: "owner",
      action: "issue.updated", details: { assigneeAgentId: agentId },
    });
    const owned = await commentWake(agentId, otherIssueId);
    await sweep();
    expect(["running", "succeeded"]).toContain((await runRow(owned.id))?.status);

    const second = await seedFocusScenario(true);
    const manual = await heartbeat.wakeup(second.agentId, {
      source: "automation", triggerDetail: "manual", reason: "issue_commented", manualUserWake: true,
      requestedByActorType: "user", requestedByActorId: "owner",
      payload: { issueId: second.otherIssueId },
      contextSnapshot: { issueId: second.otherIssueId, wakeReason: "issue_commented" },
    });
    expect(manual).not.toBeNull();
    await sweep();
    expect(["running", "succeeded"]).toContain((await runRow(manual!.id))?.status);
  });

  it("a weights change through the settings service reorders the next sweep without a restart", async () => {
    pinAdmission({ maxConcurrentRuns: 0 });
    applyRunPrioritySettings(defaultSettings());

    const review = await seedCompanyAndAgent({ name: "Reviewer2", role: "review" });
    const engineer = await seedCompanyAndAgent({ name: "Engineer2", role: "engineer" });
    const reviewIssueId = await seedIssue(review.companyId, {
      title: "Review again",
      priority: "medium",
      assigneeAgentId: review.agentId,
    });
    const engineerIssueId = await seedIssue(engineer.companyId, {
      title: "Engineer again",
      priority: "medium",
      assigneeAgentId: engineer.agentId,
    });
    const reviewRun = await wakeAndQueue(review.agentId, reviewIssueId);
    const engineerRun = await wakeAndQueue(engineer.agentId, engineerIssueId);
    // The review agent waits LONGER; defaults put it first anyway (role 90).
    await backdateRun(reviewRun.id, 30);

    const service = runPriorityService(db, { env: {} });
    const view = await service.update(
      { roleWeights: { ...defaultSettings().roleWeights, engineer: 200 } },
      { actorType: "user", actorId: "responsible-user", agentId: null, runId: null, agentApiKeyId: null },
    );
    expect(view.settings.roleWeights.engineer).toBe(200);
    // Same process: the sweeps read the in-force settings fresh every pass.
    expect(currentRunPrioritySettings().roleWeights.engineer).toBe(200);

    pinAdmission({ maxConcurrentRuns: 1 });
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    const startedEngineer = await runRow(engineerRun.id);
    const stillQueued = await runRow(reviewRun.id);
    expect(startedEngineer?.status).not.toBe("queued");
    expect(stillQueued?.status).toBe("queued");

    const audit = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(eq(activityLog.action, "instance.run_priority.updated"))
      .limit(1);
    expect(audit.length).toBeGreaterThan(0);
  }, 30_000);

  // myrmidon(OPE-13419): disk budget of the physical bot volume at the run-start gate.
  function pinDiskBudget(state: { freePercent: number; gcOk: boolean; gcCalls: number }) {
    setDiskBudgetGateForTests(
      createDiskBudgetGate({
        measure: async () => ({ freeBytes: state.freePercent * 10, totalBytes: 1000 }),
        requestGc: async () => {
          state.gcCalls += 1;
          if (!state.gcOk) throw new Error("host gc request refused");
          return true;
        },
      }),
    );
  }

  it("disk budget: at 4.9% free a run is deferred with reason disk_budget, not failed, and host GC is asked once", async () => {
    const { agentId, otherIssueId } = await seedFocusScenario(false);
    const state = { freePercent: 4.9, gcOk: true, gcCalls: 0 };
    pinDiskBudget(state);
    const first = await commentWake(agentId, otherIssueId);
    const second = await commentWake(agentId, otherIssueId);
    await sweep();
    for (const run of [first, second]) {
      const row = await runRow(run.id);
      if (!row) continue;
      expect(["scheduled_retry", "cancelled"]).toContain(row.status);
    }
    const row = await runRow(first.id);
    expect(row?.status).toBe("scheduled_retry");
    expect(row?.scheduledRetryAt).not.toBeNull();
    const marker = JSON.stringify(row?.contextSnapshot);
    expect(marker).toContain("diskBudgetDeferral");
    expect(marker).toContain("disk_budget");
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    expect(state.gcCalls).toBe(1);
  }, 30_000);

  it("disk budget: the deferred run starts by itself once the volume is back at 5% free", async () => {
    const { agentId, otherIssueId } = await seedFocusScenario(false);
    const state = { freePercent: 4.9, gcOk: true, gcCalls: 0 };
    pinDiskBudget(state);
    const run = await commentWake(agentId, otherIssueId);
    await sweep();
    expect((await runRow(run.id))?.status).toBe("scheduled_retry");
    state.freePercent = 5;
    await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(Date.now() - 1000) }).where(eq(heartbeatRuns.id, run.id));
    await heartbeat.promoteDueScheduledRetries();
    await sweep();
    // The run left the wait and was claimed (whatever the sandbox then does with it).
    const started = await runRow(run.id);
    expect(started?.startedAt).not.toBeNull();
    expect(started?.status).not.toBe("scheduled_retry");
    expect(started?.status).not.toBe("queued");
  }, 30_000);

  it("disk budget: a refused cleanup request does not fail the run; it stays deferred", async () => {
    const { agentId, otherIssueId } = await seedFocusScenario(false);
    const state = { freePercent: 3, gcOk: false, gcCalls: 0 };
    pinDiskBudget(state);
    const run = await commentWake(agentId, otherIssueId);
    await sweep();
    const row = await runRow(run.id);
    expect(row?.status).toBe("scheduled_retry");
    expect(JSON.stringify(row?.contextSnapshot)).toContain('"hostGc":"failed"');
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  }, 30_000);
});
