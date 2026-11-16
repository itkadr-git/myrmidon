import { mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { publishKnowledgeExport, type GitExportRunner } from "./git-export-git.js";
import type { KnowledgeGitTree } from "./git-export.js";

const repoUrl = "https://example.test/knowledge.git";
const branch = "knowledge-export";
const commit = "0123456789abcdef0123456789abcdef01234567";
const tree: KnowledgeGitTree = {
  files: [{ path: "ops/runbook.md", content: "Runbook\n" }],
  contentHash: "fixture-content-hash-1234567890",
  pageCount: 1,
  excludedLifePages: 0,
};

async function withWorkspace(run: (workDir: string) => Promise<void>) {
  const root = await mkdtemp(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), "knowledge-commit-"));
  try {
    await run(path.join(root, "checkout"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function recordingRunner(failCommit: boolean) {
  const calls: { cwd: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const runner: GitExportRunner = {
    async git(cwd, args, env) {
      calls.push({ cwd, args: [...args], env: env && { ...env } });
      if (args[0] === "commit" && failCommit) throw new Error("commit failed");
      return { stdout: args[0] === "status" ? "A  ops/runbook.md\n" : args[0] === "rev-parse" ? `${commit}\n` : "", stderr: "" };
    },
  };
  return { runner, calls };
}

function expectedPrefix(workDir: string) {
  return [
    ["ls-remote", "--heads", repoUrl, branch],
    ["init", "-b", branch],
    ["remote", "add", "origin", repoUrl],
    ["ls-files", "-z"],
    ["add", "-A"],
    ["status", "--porcelain"],
    ["commit", "--allow-empty-message", "-m", "myrmidon(KNOWLEDGE-2.0 L-8): export 1 pages fixture-cont"],
  ].map((args) => ({ cwd: workDir, args }));
}

describe("knowledge export commit fail-stop", () => {
  it("rejects a failed commit without reading HEAD or pushing", async () => {
    await withWorkspace(async (workDir) => {
      const { runner, calls } = recordingRunner(true);
      await expect(publishKnowledgeExport({ workDir, repoUrl, branch, tree, runner })).rejects.toThrow("commit failed");
      expect(calls.map(({ cwd, args }) => ({ cwd, args }))).toEqual(expectedPrefix(workDir));
      expect(calls.some(({ args }) => args[0] === "rev-parse" || args[0] === "push")).toBe(false);
    });
  });

  it("publishes a dirty tree with the fixed author and one push", async () => {
    await withWorkspace(async (workDir) => {
      const { runner, calls } = recordingRunner(false);
      const result = await publishKnowledgeExport({ workDir, repoUrl, branch, tree, runner, env: { GIT_AUTHOR_NAME: "ignored" } });
      expect(result).toEqual({ committed: true, commit, contentHash: tree.contentHash, pageCount: 1 });
      expect(calls.map(({ cwd, args }) => ({ cwd, args }))).toEqual([
        ...expectedPrefix(workDir),
        { cwd: workDir, args: ["rev-parse", "HEAD"] },
        { cwd: workDir, args: ["push", "origin", `HEAD:${branch}`] },
      ]);
      expect(calls.find(({ args }) => args[0] === "commit")?.env).toEqual({
        GIT_AUTHOR_NAME: "myrmidon-knowledge-export",
        GIT_AUTHOR_EMAIL: "knowledge-export@myrmidon.invalid",
        GIT_COMMITTER_NAME: "myrmidon-knowledge-export",
        GIT_COMMITTER_EMAIL: "knowledge-export@myrmidon.invalid",
      });
      expect(calls.filter(({ args }) => args[0] === "push")).toHaveLength(1);
    });
  });
});
