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
  currentRunPrioritySettings,
  resetRunPriorityForTests,
} from "../myrmidon/run-priority/state.js";
import { runPriorityService } from "../myrmidon/run-priority/service.js";

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
    expect(stillQueued.contextSnapshot).toMatchObject({ waitReason: "global_cap" });
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

    // Plain is OLDER (pure FIFO would start it first); both score 60 for the
    // medium issue and the engineer role, but the release label adds the +20
    // current-release bonus, so the release run takes the single slot.
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
    // The medium run waited past seven aging steps (max(50,60)+7*5 = 95)
    // while the fresh high one scores 80. The old per-agent comparator (rank
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
});
