// myrmidon(1.6.9, OPE-13213): a run of an agent that works in its own container
// gets the task directory of the bot as its isolated workspace. The board makes
// no worktree and no shared checkout for it.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  activityLog,
  budgetPolicies,
  companies,
  companySkills,
  createDb,
  environments,
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
  type AdapterExecutionContext,
} from "../adapters/index.ts";
import { resolveManagedProjectWorkspaceDir } from "../home-paths.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { executionWorkspaceService } from "../services/execution-workspaces.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { setBotContainerWorkspaceAdapterTypesForTests } from "../services/bot-container-workspace.ts";

const execFileAsync = promisify(execFile);
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const BOT_CONTAINER_TEST_ADAPTER = "bot_container_workspace_test";
const REPO_ONLY_URL = "https://github.com/example/bot-container-repo.git";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres bot-container workspace tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("bot-container isolated workspace", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let projectCwd!: string;
  const executedInputs = new Map<string, AdapterExecutionContext>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-bot-container-workspace-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    projectCwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-bot-container-workspace-"));
    await execFileAsync("git", ["init", "--quiet", projectCwd]);
    await execFileAsync("git", [
      "-C", projectCwd, "-c", "user.name=Test", "-c", "user.email=test@example.com",
      "commit", "--allow-empty", "-m", "initial",
    ]);
    setBotContainerWorkspaceAdapterTypesForTests([BOT_CONTAINER_TEST_ADAPTER]);
    registerServerAdapter({
      type: BOT_CONTAINER_TEST_ADAPTER,
      execute: async (input) => {
        executedInputs.set(input.runId, input);
        return { exitCode: 0, signal: null, timedOut: false, resultJson: {} };
      },
      testEnvironment: async () => ({
        adapterType: BOT_CONTAINER_TEST_ADAPTER,
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
        await db.delete(environments);
        await db.delete(companySkills);
        await db.delete(companies);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    executedInputs.clear();
  });

  afterAll(async () => {
    setBotContainerWorkspaceAdapterTypesForTests(null);
    unregisterServerAdapter(BOT_CONTAINER_TEST_ADAPTER);
    if (projectCwd) await fs.rm(projectCwd, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  async function waitForRunToLeaveActiveStates(runId: string, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = await heartbeat.getRun(runId);
      if (run && !["queued", "running"].includes(run.status)) return run;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return await heartbeat.getRun(runId);
  }

  async function seedTwoIssuesOfOneAgent(options: { repoOnly?: boolean } = {}) {
    await instanceSettingsService(db).updateExperimental({
      enableIsolatedWorkspaces: true,
      enableIsolatedWorkspacesByDefault: false,
    });
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const agentId = randomUUID();
    const issueIds = [randomUUID(), randomUUID()];
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Bot container project" });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      ...(options.repoOnly
        ? {
            sourceType: "git_repo",
            cwd: null,
            repoUrl: REPO_ONLY_URL,
            repoRef: "main",
          }
        : { sourceType: "local_path", cwd: projectCwd }),
      isPrimary: true,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ContainerCoder",
      role: "engineer",
      status: "idle",
      adapterType: BOT_CONTAINER_TEST_ADAPTER,
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    for (const [index, issueId] of issueIds.entries()) {
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: `Container issue ${index + 1}`,
        status: "in_progress",
        priority: "medium",
        responsibleUserId: "responsible-user",
        assigneeAgentId: agentId,
        projectId,
        projectWorkspaceId,
        issueNumber: index + 1,
        identifier: `${issuePrefix}-${index + 1}`,
        executionWorkspaceSettings: { mode: "isolated_workspace" },
      });
    }
    return { companyId, projectId, agentId, issueIds, issuePrefix };
  }

  it("records one bot_container workspace per task and leaves no file on the board side", async () => {
    const fixture = await seedTwoIssuesOfOneAgent();
    const runs = [];
    for (const issueId of fixture.issueIds) {
      const run = await heartbeat.invoke(
        fixture.agentId,
        "assignment",
        { issueId, wakeReason: "issue_assigned" },
        "system",
      );
      expect(run).not.toBeNull();
      runs.push(run!);
    }
    const finished = [];
    for (const run of runs) finished.push(await waitForRunToLeaveActiveStates(run.id));
    expect(finished.map((run) => run?.status)).toEqual(["succeeded", "succeeded"]);
    expect(finished.map((run) => run?.errorCode)).not.toContain("workspace_busy");

    const rows = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.projectId, fixture.projectId));
    expect(rows).toHaveLength(2);
    for (const [index, issueId] of fixture.issueIds.entries()) {
      const identifier = `${fixture.issuePrefix}-${index + 1}`;
      const row = rows.find((candidate) => candidate.sourceIssueId === issueId);
      expect(row).toMatchObject({
        mode: "isolated_workspace",
        strategyType: "bot_container",
        providerType: "adapter_managed",
        cwd: `/workspace/${identifier}`,
        providerRef: null,
      });
      const workspaceContext = executedInputs.get(runs[index]!.id)?.context.paperclipWorkspace as
        | Record<string, unknown>
        | undefined;
      expect(workspaceContext).toMatchObject({
        cwd: `/workspace/${identifier}`,
        strategy: "bot_container",
        mode: "isolated_workspace",
        worktreePath: null,
      });
    }
    // Nothing was created under the project on the board side.
    await expect(fs.stat(path.join(projectCwd, ".paperclip", "worktrees"))).rejects.toThrow();
    const worktrees = await execFileAsync("git", ["-C", projectCwd, "worktree", "list", "--porcelain"]);
    expect(worktrees.stdout.match(/^worktree /gm)).toHaveLength(1);
  }, 60_000);

  it("clones and creates nothing on the board for a project that has only a repository", async () => {
    const fixture = await seedTwoIssuesOfOneAgent({ repoOnly: true });
    const issueId = fixture.issueIds[0]!;
    const run = await heartbeat.invoke(
      fixture.agentId,
      "assignment",
      { issueId, wakeReason: "issue_assigned" },
      "system",
    );
    expect(run).not.toBeNull();
    expect((await waitForRunToLeaveActiveStates(run!.id))?.status).toBe("succeeded");

    const identifier = `${fixture.issuePrefix}-1`;
    const [row] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.sourceIssueId, issueId));
    expect(row).toMatchObject({ strategyType: "bot_container", cwd: `/workspace/${identifier}`, repoUrl: REPO_ONLY_URL });
    expect(executedInputs.get(run!.id)?.context.paperclipWorkspace).toMatchObject({
      cwd: `/workspace/${identifier}`,
      repoUrl: REPO_ONLY_URL,
      repoRef: "main",
    });

    // The managed checkout directory of the project, its parents and any clone temp
    // directory stay absent: the board holds no copy.
    const managedDir = resolveManagedProjectWorkspaceDir({
      companyId: fixture.companyId,
      projectId: fixture.projectId,
      repoName: "bot-container-repo",
    });
    await expect(fs.stat(path.dirname(managedDir))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.dirname(path.dirname(managedDir)))).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

  it("reuses the same row on the next run of the same task", async () => {
    const fixture = await seedTwoIssuesOfOneAgent();
    const issueId = fixture.issueIds[0]!;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const run = await heartbeat.invoke(
        fixture.agentId,
        "assignment",
        { issueId, wakeReason: "issue_assigned" },
        "system",
      );
      expect(run).not.toBeNull();
      expect((await waitForRunToLeaveActiveStates(run!.id))?.status).toBe("succeeded");
    }
    const rows = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.sourceIssueId, issueId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ strategyType: "bot_container", status: "active" });
  }, 60_000);

  it("archives a bot_container workspace once its task is done, with nothing to remove on the board", async () => {
    const fixture = await seedTwoIssuesOfOneAgent();
    const issueId = fixture.issueIds[0]!;
    const run = await heartbeat.invoke(
      fixture.agentId,
      "assignment",
      { issueId, wakeReason: "issue_assigned" },
      "system",
    );
    expect((await waitForRunToLeaveActiveStates(run!.id))?.status).toBe("succeeded");
    await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, issueId));
    // No follow-up run of the task may still be live when the sweep looks at it.
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    const service = executionWorkspaceService(db, {
      workspaceReaperCooldownDays: 0,
      myrmidonWorkspaceMergedCooldownMs: 0,
      sharedSweepPauseMs: 0,
    });
    const sweep = await service.sweepTerminalWorkspaces();
    expect(sweep).toMatchObject({ skippedInspectFailed: 0, skippedDirty: 0, skippedUnmerged: 0 });
    const [row] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.sourceIssueId, issueId));
    expect(row, JSON.stringify(sweep)).toMatchObject({ status: "archived", cleanupReason: "issue_terminal" });
  }, 60_000);
});
