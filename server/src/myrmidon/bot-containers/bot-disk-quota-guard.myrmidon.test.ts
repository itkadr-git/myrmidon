// myrmidon(1.6.1-BOT-DISK-C): guard test for the clone rejection at the exact
// integration point — realizeExecutionWorkspace. Red: the admission check says
// "no rejection" and the fresh worktree directory is created. Green: the check
// says over-quota and the worktree is refused BEFORE its directory is created,
// with the stable BOT_DISK_QUOTA_EXCEEDED code in the message.
//
// Only the admission function is mocked (on top of the real module) so nothing
// else in the import chain changes behaviour; a fresh repo per creating test
// keeps the reuse fast-path from masking the guard.

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { botDiskQuotaRejectionMock } = vi.hoisted(() => ({
  botDiskQuotaRejectionMock: vi.fn(async (_db: unknown, _agentId: unknown): Promise<string | null> => null),
}));

vi.mock("./bot-quota.js", () => ({
  botDiskQuotaRejection: botDiskQuotaRejectionMock,
  BOT_VOLUME_ROOT_ENV: "MYRMIDON_BOT_VOLUME_ROOT",
  readBotDiskQuotaSignals: () => [],
}));

import {
  realizeExecutionWorkspace,
  WorkspaceRuntimeValidationFailure,
} from "../../services/workspace-runtime.js";
import { BOT_DISK_QUOTA_EXCEEDED_ERROR_CODE } from "@paperclipai/shared";

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd });
}

async function createTempRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bot-quota-guard-"));
  const repoRoot = path.join(root, "repo");
  await fs.mkdir(repoRoot);
  await runGit(repoRoot, ["init", "-b", "master"]);
  await runGit(repoRoot, ["config", "user.email", "test@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Test"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "seed\n");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "seed"]);
  return repoRoot;
}

function realizeInput(repoRoot: string) {
  return {
    base: {
      baseCwd: repoRoot,
      source: "project_primary" as const,
      projectId: "project-1",
      workspaceId: "workspace-1",
      repoUrl: null,
      repoRef: "master",
    },
    config: {
      workspaceStrategy: {
        type: "git_worktree",
        branchTemplate: "{{issue.identifier}}-{{slug}}",
      },
    },
    issue: { id: "issue-1", identifier: "OPE-4023", title: "Quota guard" },
    agent: { id: "agent-1", name: "Quota Bot", companyId: "company-1" },
  } satisfies Parameters<typeof realizeExecutionWorkspace>[0];
}

describe("myrmidon(BOT-DISK-C) clone admission guard", () => {
  const roots: string[] = [];

  async function newRepo() {
    const repoRoot = await createTempRepo();
    roots.push(path.dirname(repoRoot));
    return repoRoot;
  }

  afterAll(async () => {
    await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("red: without an exceeded quota the worktree directory is created", async () => {
    const repoRoot = await newRepo();
    botDiskQuotaRejectionMock.mockResolvedValueOnce(null);
    const workspace = await realizeExecutionWorkspace(realizeInput(repoRoot));
    expect(workspace.created).toBe(true);
    expect(workspace.strategy).toBe("git_worktree");
    expect(workspace.worktreePath).toBeTruthy();
    await expect(fs.stat(workspace.worktreePath as string)).resolves.toBeTruthy();
  });

  it("green: an exceeded quota refuses the clone before the directory is created", async () => {
    const repoRoot = await newRepo();
    const rejection = `${BOT_DISK_QUOTA_EXCEEDED_ERROR_CODE}: Quota Bot has used 1500 MB of its 1000 MB disk quota.`;
    botDiskQuotaRejectionMock.mockResolvedValueOnce(rejection);

    const error = await realizeExecutionWorkspace(realizeInput(repoRoot)).then(
      () => null,
      (caught) => caught,
    );
    expect(error).toBeInstanceOf(WorkspaceRuntimeValidationFailure);
    expect((error as WorkspaceRuntimeValidationFailure).message).toBe(rejection);
    expect((error as WorkspaceRuntimeValidationFailure).resultJson).toMatchObject({
      workspaceValidation: {
        reason: "bot_disk_quota_exceeded",
        reasonCode: BOT_DISK_QUOTA_EXCEEDED_ERROR_CODE,
        agentId: "agent-1",
      },
    });
    // the refusal happens before the worktree is created: the parent
    // `.paperclip/worktrees` directory exists (made early) but stays empty, and
    // no branch was made
    await expect(fs.readdir(path.join(repoRoot, ".paperclip", "worktrees"))).resolves.toEqual([]);
    const branches = await execFileAsync("git", ["branch", "--list"], { cwd: repoRoot });
    expect(branches.stdout).not.toContain("OPE-4023");
  });

  it("the admission check sees the agent id of the run", async () => {
    const repoRoot = await newRepo();
    botDiskQuotaRejectionMock.mockResolvedValueOnce(null);
    await realizeExecutionWorkspace(realizeInput(repoRoot));
    const lastCall = botDiskQuotaRejectionMock.mock.calls[botDiskQuotaRejectionMock.mock.calls.length - 1] as unknown[];
    expect(lastCall[1]).toBe("agent-1");
  });
});
