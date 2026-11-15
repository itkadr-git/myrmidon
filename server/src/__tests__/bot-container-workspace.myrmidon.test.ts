// myrmidon(1.6.9, OPE-13213): the isolated workspace of a bot-container task is
// the bot's task directory; board-side worktrees obey the bot-disk threshold.

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  botContainerWorkspaceCwd,
  realizeBotContainerWorkspace,
  resolveBotContainerWorkspace,
  usesBotContainerWorkspace,
} from "../services/bot-container-workspace.ts";
import {
  measurePartitionUsedPercent,
  worktreePartitionRefusal,
} from "../services/worktree-partition-guard.ts";
import {
  cleanupExecutionWorkspaceArtifacts,
  realizeExecutionWorkspace,
} from "../services/workspace-runtime.ts";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

async function createTempRepo() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bot-container-ws-repo-"));
  tempDirs.push(repoRoot);
  const git = (args: string[]) => execFileAsync("git", args, { cwd: repoRoot });
  await git(["init"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Test"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "hello\n", "utf8");
  await git(["add", "README.md"]);
  await git(["commit", "-m", "Initial commit"]);
  await git(["checkout", "-B", "main"]);
  return repoRoot;
}

const base = {
  baseCwd: "/srv/board/project",
  source: "project_primary" as const,
  projectId: "project-1",
  workspaceId: "workspace-1",
  repoUrl: "https://github.com/example/repo.git",
  repoRef: "main",
};

describe("bot-container workspace resolution", () => {
  it("covers the adapters that work in their own container", () => {
    expect(usesBotContainerWorkspace("hermes_gateway")).toBe(true);
    expect(usesBotContainerWorkspace("omp_local")).toBe(true);
    expect(usesBotContainerWorkspace("claude_local")).toBe(false);
    expect(usesBotContainerWorkspace(null)).toBe(false);
  });

  it("maps a task identifier to /workspace/<ISSUE> and rejects anything else", () => {
    expect(botContainerWorkspaceCwd("OPE-13213")).toBe("/workspace/OPE-13213");
    expect(botContainerWorkspaceCwd("../etc")).toBeNull();
    expect(botContainerWorkspaceCwd("ope-1")).toBeNull();
    expect(botContainerWorkspaceCwd(null)).toBeNull();
  });

  it("applies only to an isolated run of a container adapter with a usable identifier", () => {
    expect(
      resolveBotContainerWorkspace({ adapterType: "hermes_gateway", mode: "isolated_workspace", issueIdentifier: "OPE-7" }),
    ).toEqual({ cwd: "/workspace/OPE-7" });
    expect(
      resolveBotContainerWorkspace({ adapterType: "hermes_gateway", mode: "shared_workspace", issueIdentifier: "OPE-7" }),
    ).toBeNull();
    expect(
      resolveBotContainerWorkspace({ adapterType: "claude_local", mode: "isolated_workspace", issueIdentifier: "OPE-7" }),
    ).toBeNull();
    expect(
      resolveBotContainerWorkspace({ adapterType: "omp_local", mode: "isolated_workspace", issueIdentifier: null }),
    ).toBeNull();
  });

  it("realizes the workspace without any file on the board side", () => {
    const workspace = realizeBotContainerWorkspace(base, { cwd: "/workspace/OPE-7" });
    expect(workspace).toMatchObject({
      strategy: "bot_container",
      cwd: "/workspace/OPE-7",
      worktreePath: null,
      branchName: null,
      created: false,
      repoUrl: base.repoUrl,
      repoRef: "main",
    });
  });

  it("cleans a bot_container row without touching any path on the board", async () => {
    const cleanup = await cleanupExecutionWorkspaceArtifacts({
      workspace: {
        id: "execution-workspace-bot",
        cwd: "/workspace/OPE-7",
        providerType: "adapter_managed",
        providerRef: null,
        branchName: null,
        repoUrl: null,
        baseRef: null,
        projectId: "project-1",
        projectWorkspaceId: "workspace-1",
        sourceIssueId: "issue-1",
        metadata: {},
      },
      projectWorkspace: { cwd: "/srv/board/project", cleanupCommand: null },
    });
    expect(cleanup.cleaned).toBe(true);
    expect(cleanup.warnings).toEqual([]);
  });
});

describe("board-side worktree partition guard", () => {
  it("measures a real partition and walks up from a directory that does not exist yet", async () => {
    const used = await measurePartitionUsedPercent(path.join(os.tmpdir(), "does", "not", "exist", "yet"));
    expect(used).not.toBeNull();
    expect(used!).toBeGreaterThanOrEqual(0);
    expect(used!).toBeLessThanOrEqual(100);
  });

  it("refuses at or above the default threshold of 90 and names the reason", async () => {
    const refusal = await worktreePartitionRefusal({
      worktreeParentDir: "/srv/worktrees",
      measure: async () => 93.4,
    });
    expect(refusal).toContain("WORKTREE_PARTITION_FULL");
    expect(refusal).toContain("93.4%");
    expect(refusal).toContain("90%");
    expect(await worktreePartitionRefusal({ worktreeParentDir: "/srv/worktrees", measure: async () => 90 })).not.toBeNull();
  });

  it("allows below the threshold and when the partition cannot be measured", async () => {
    expect(await worktreePartitionRefusal({ worktreeParentDir: "/x", measure: async () => 89.9 })).toBeNull();
    expect(await worktreePartitionRefusal({ worktreeParentDir: "/x", measure: async () => null })).toBeNull();
  });

  it("refuses to create a git worktree on a full partition and creates one below the threshold", async () => {
    const repoRoot = await createTempRepo();
    const input = {
      base: { ...base, baseCwd: repoRoot, repoUrl: null, repoRef: "HEAD" },
      config: { workspaceStrategy: { type: "git_worktree", branchTemplate: "{{issue.identifier}}-{{slug}}" } },
      issue: { id: "issue-1", identifier: "PAP-447", title: "Guard" },
      agent: { id: "agent-1", name: "Local Coder", companyId: "company-1" },
    } satisfies Parameters<typeof realizeExecutionWorkspace>[0];

    await expect(
      realizeExecutionWorkspace({ ...input, worktreePartitionUsedPercent: async () => 96 }),
    ).rejects.toThrow(/WORKTREE_PARTITION_FULL/);
    await expect(fs.stat(path.join(repoRoot, ".paperclip", "worktrees", "PAP-447-guard"))).rejects.toThrow();

    const created = await realizeExecutionWorkspace({ ...input, worktreePartitionUsedPercent: async () => 12 });
    expect(created.strategy).toBe("git_worktree");
    await expect(fs.stat(path.join(created.cwd, ".git"))).resolves.toBeTruthy();

    // Reuse of an existing worktree is never blocked by a full partition.
    const reused = await realizeExecutionWorkspace({ ...input, worktreePartitionUsedPercent: async () => 99 });
    expect(reused.cwd).toBe(created.cwd);
    expect(reused.created).toBe(false);
  });

  it("removes a board-side worktree when the workspace is cleaned up after the task is done", async () => {
    const repoRoot = await createTempRepo();
    const workspace = await realizeExecutionWorkspace({
      base: { ...base, baseCwd: repoRoot, repoUrl: null, repoRef: "HEAD" },
      config: { workspaceStrategy: { type: "git_worktree", branchTemplate: "{{issue.identifier}}-{{slug}}" } },
      issue: { id: "issue-2", identifier: "PAP-448", title: "Cleanup" },
      agent: { id: "agent-1", name: "Local Coder", companyId: "company-1" },
      worktreePartitionUsedPercent: async () => 10,
    });
    await expect(fs.stat(workspace.cwd)).resolves.toBeTruthy();

    const cleanup = await cleanupExecutionWorkspaceArtifacts({
      workspace: {
        id: "execution-workspace-done",
        cwd: workspace.cwd,
        providerType: "git_worktree",
        providerRef: workspace.worktreePath,
        branchName: workspace.branchName,
        repoUrl: null,
        baseRef: "HEAD",
        projectId: "project-1",
        projectWorkspaceId: "workspace-1",
        sourceIssueId: "issue-2",
        metadata: { createdByRuntime: workspace.branchCreatedByRuntime, gitBranchOwnershipVersion: 1 },
      },
      projectWorkspace: { cwd: repoRoot, cleanupCommand: null },
    });
    expect(cleanup.cleaned).toBe(true);
    await expect(fs.stat(workspace.cwd)).rejects.toThrow();
  });
});
