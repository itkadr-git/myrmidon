import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
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
  const base = process.env.MYRMIDON_RUN_SCRATCH_DIR || process.env.MYRMIDON_SCRATCH_DIR || homedir();
  const root = await mkdtemp(path.join(base, "myrmidon-export-init-"));
  try {
    await run(path.join(root, "checkout"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function recordingRunner(failInit: boolean) {
  const calls: { cwd: string; args: string[] }[] = [];
  const runner: GitExportRunner = {
    async git(cwd, args) {
      calls.push({ cwd, args: [...args] });
      if (args[0] === "init" && failInit) throw new Error("init failed");
      const stdout = args[0] === "status" ? "A  ops/runbook.md\n"
        : args[0] === "rev-parse" ? `${commit}\n` : "";
      return { stdout, stderr: "" };
    },
  };
  return { runner, calls };
}

describe("knowledge export init fail-stop", () => {
  it("propagates init failure before configuring the remote or writing the tree", async () => {
    await withWorkspace(async (workDir) => {
      const { runner, calls } = recordingRunner(true);
      await expect(publishKnowledgeExport({ workDir, repoUrl, branch, tree, runner })).rejects.toThrow("init failed");
      expect(calls).toEqual([
        { cwd: workDir, args: ["ls-remote", "--heads", repoUrl, branch] },
        { cwd: workDir, args: ["init", "-b", branch] },
      ]);
      expect(await readdir(workDir)).toEqual([]);
    });
  });

  it("publishes the exact tree after successful init", async () => {
    await withWorkspace(async (workDir) => {
      const { runner, calls } = recordingRunner(false);
      const result = await publishKnowledgeExport({ workDir, repoUrl, branch, tree, runner });
      expect(result).toEqual({ committed: true, commit, contentHash: tree.contentHash, pageCount: 1 });
      expect(await readFile(path.join(workDir, "ops/runbook.md"))).toEqual(Buffer.from("Runbook\n"));
      expect(calls).toEqual([
        { cwd: workDir, args: ["ls-remote", "--heads", repoUrl, branch] },
        { cwd: workDir, args: ["init", "-b", branch] },
        { cwd: workDir, args: ["remote", "add", "origin", repoUrl] },
        { cwd: workDir, args: ["ls-files", "-z"] },
        { cwd: workDir, args: ["add", "-A"] },
        { cwd: workDir, args: ["status", "--porcelain"] },
        { cwd: workDir, args: ["commit", "--allow-empty-message", "-m", "myrmidon(KNOWLEDGE-2.0 L-8): export 1 pages fixture-cont"] },
        { cwd: workDir, args: ["rev-parse", "HEAD"] },
        { cwd: workDir, args: ["push", "origin", `HEAD:${branch}`] },
      ]);
    });
  });
});
