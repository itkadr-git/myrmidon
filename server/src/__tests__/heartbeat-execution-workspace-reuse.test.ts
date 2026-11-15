import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, describe } from "vitest";
import {
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  activityLog,
  budgetPolicies,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
  projects,
  projectWorkspaces,
} from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import {
  registerServerAdapter,
  unregisterServerAdapter,
} from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { issueService } from "../services/issues.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const REUSE_TEST_ADAPTER = "execution_workspace_reuse_test";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres execution-workspace reuse tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("execution workspace row lifecycle across runs", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let workspaceCwd!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-execution-workspace-reuse-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    workspaceCwd = await fs.mkdtemp(path.join(os.tmpdir(), "myrmidon-execution-workspace-reuse-"));
    registerServerAdapter({
      type: REUSE_TEST_ADAPTER,
      execute: async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        resultJson: {},
      }),
      testEnvironment: async () => ({
        adapterType: REUSE_TEST_ADAPTER,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
  }, 60_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await db.delete(activityLog);
        await db.delete(environmentLeases);
        await db.delete(issueComments);
        await db.delete(issueRelations);
        await db.delete(issues);
        await db.delete(executionWorkspaces);
        await db.delete(projectWorkspaces);
        await db.delete(projects);
        await db.delete(heartbeatRunEvents);
        await db.delete(activityLog);
        await db.delete(heartbeatRuns);
        await db.delete(agentWakeupRequests);
        await db.delete(agentRuntimeState);
        await db.delete(budgetPolicies);
        await db.delete(agents);
        await db.delete(companySkills);
        await db.delete(companies);
        return;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  });

  afterAll(async () => {
    unregisterServerAdapter(REUSE_TEST_ADAPTER);
    if (workspaceCwd) await fs.rm(workspaceCwd, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  async function waitForRunToFinish(runId: string, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = await heartbeat.getRun(runId);
      if (run && !["queued", "running"].includes(run.status)) return run;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return await heartbeat.getRun(runId);
  }

  async function seedIssue() {
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Myrmidon",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Workspace Reuse Project" });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      sourceType: "local_path",
      cwd: workspaceCwd,
      isPrimary: true,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ReuseCoder",
      role: "engineer",
      status: "idle",
      adapterType: REUSE_TEST_ADAPTER,
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Reuse issue",
      status: "in_progress",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: agentId,
      projectId,
      projectWorkspaceId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    return { companyId, projectId, agentId, issueId };
  }

  async function runOnce(agentId: string, issueId: string) {
    // A reason-less invoke is a throttle candidate: after two no-progress runs
    // on the issue the re-wake cooldown (issue_rewake_throttled) holds the next
    // wake back and admission returns null — unless some activity-log row
    // happens to land after the previous run finished, which made this test
    // flaky. The real assignment path carries reason issue_assigned, which
    // is never throttled, so the test wakes the same way.
    const run = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "system",
    });
    expect(run).not.toBeNull();
    const finished = await waitForRunToFinish(run!.id);
    expect(finished?.status).toBe("succeeded");
    return run!;
  }

  async function rowsForIssue(issueId: string) {
    return db.select().from(executionWorkspaces).where(eq(executionWorkspaces.sourceIssueId, issueId));
  }

  it("three consecutive runs reuse one stored row and refresh last_used_at; completing the task archives it", async () => {
    const fixture = await seedIssue();

    await runOnce(fixture.agentId, fixture.issueId);
    const afterFirst = await rowsForIssue(fixture.issueId);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]?.status).toBe("active");
    expect(afterFirst[0]?.mode).toBe("shared_workspace");
    const rowId = afterFirst[0]!.id;
    let previousLastUsedAt = afterFirst[0]!.lastUsedAt.getTime();

    for (let run = 2; run <= 3; run += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await runOnce(fixture.agentId, fixture.issueId);
      const rows = await rowsForIssue(fixture.issueId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(rowId);
      expect(rows[0]?.status).toBe("active");
      expect(rows[0]!.lastUsedAt.getTime()).toBeGreaterThan(previousLastUsedAt);
      previousLastUsedAt = rows[0]!.lastUsedAt.getTime();
    }

    const boundIssue = await db.select().from(issues).where(eq(issues.id, fixture.issueId)).then((r) => r[0]!);
    expect(boundIssue.executionWorkspaceId).toBe(rowId);

    await issueService(db).update(fixture.issueId, { status: "done", companyGuard: fixture.companyId });

    const afterDone = await rowsForIssue(fixture.issueId);
    expect(afterDone).toHaveLength(1);
    expect(afterDone[0]?.id).toBe(rowId);
    expect(afterDone[0]?.status).toBe("archived");
    expect(afterDone[0]?.closedAt).not.toBeNull();
    expect(afterDone[0]?.cleanupReason).toBe("issue_terminal");
  });
});
