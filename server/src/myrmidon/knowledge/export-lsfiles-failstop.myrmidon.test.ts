import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { publishKnowledgeExport, type GitExportRunner } from "./git-export-git.js";
import type { KnowledgeGitTree } from "./git-export.js";

const branch = "knowledge-export";
const repoUrl = "https://example.test/knowledge.git";
const commit = "a".repeat(40);
const tree: KnowledgeGitTree = {
  files: [{ path: "keep.md", content: "new content\n" }],
  contentHash: "fixture-hash",
  pageCount: 1,
  excludedLifePages: 0,
};

async function withCheckout(run: (workDir: string) => Promise<void>) {
  const base = process.env.MYRMIDON_RUN_SCRATCH_DIR || process.env.MYRMIDON_SCRATCH_DIR || homedir();
  const root = await mkdtemp(path.join(base, "myrmidon-lsfiles-"));
  const workDir = path.join(root, "checkout");
  try {
    await mkdir(path.join(workDir, ".git"), { recursive: true });
    await writeFile(path.join(workDir, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
    await mkdir(path.join(workDir, "company-a"));
    await mkdir(path.join(workDir, "company-b"));
    await writeFile(path.join(workDir, "company-a", "keep.md"), "old content\n");
    await writeFile(path.join(workDir, "company-a", "stale.md"), "stale\n");
    await writeFile(path.join(workDir, "company-a", "untracked.md"), "untracked\n");
    await writeFile(path.join(workDir, "company-b", "other.md"), "other\n");
    await run(workDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function recordingRunner(fail: boolean) {
  const calls: { cwd: string; args: string[] }[] = [];
  const runner: GitExportRunner = {
    async git(cwd, args) {
      calls.push({ cwd, args: [...args] });
      if (args[0] === "ls-files" && fail) throw new Error("inventory failed");
      const stdout = args[0] === "ls-files" ? "company-a/keep.md\0company-a/stale.md\0company-b/other.md\0"
        : args[0] === "status" ? (args.includes("-z") ? "" : " M company-a/keep.md\n D company-a/stale.md\n")
        : args[0] === "rev-parse" ? `${commit}\n` : "";
      return { stdout, stderr: "" };
    },
  };
  return { runner, calls };
}

describe("knowledge export ls-files fail-stop", () => {
  it("propagates inventory failure after writing the tree and before staging or publishing", async () => {
    await withCheckout(async (workDir) => {
      const { runner, calls } = recordingRunner(true);
      await expect(publishKnowledgeExport({ workDir, repoUrl, branch, tree, runner, pathPrefix: "company-a" })).rejects.toThrow("inventory failed");
      expect(await readFile(path.join(workDir, "company-a", "keep.md"))).toEqual(Buffer.from("new content\n"));
      expect(await readFile(path.join(workDir, "company-a", "stale.md"))).toEqual(Buffer.from("stale\n"));
      expect(calls).toEqual([
        { cwd: workDir, args: ["fetch", "origin", branch] },
        { cwd: workDir, args: ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`] },
        { cwd: workDir, args: ["checkout", branch] },
        { cwd: workDir, args: ["merge", "--ff-only", "FETCH_HEAD"] },
        { cwd: workDir, args: ["status", "--porcelain", "-z", "--untracked-files=all"] },
        { cwd: workDir, args: ["ls-files", "-z"] },
      ]);
    });
  });

  it("deletes only stale tracked files in the company and publishes the resulting tree", async () => {
    await withCheckout(async (workDir) => {
      const { runner, calls } = recordingRunner(false);
      const result = await publishKnowledgeExport({ workDir, repoUrl, branch, tree, runner, pathPrefix: "company-a" });
      expect(result).toEqual({ committed: true, commit, contentHash: tree.contentHash, pageCount: 1 });
      expect(await readFile(path.join(workDir, "company-a", "keep.md"))).toEqual(Buffer.from("new content\n"));
      await expect(readFile(path.join(workDir, "company-a", "stale.md"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(path.join(workDir, "company-a", "untracked.md"))).toEqual(Buffer.from("untracked\n"));
      expect(await readFile(path.join(workDir, "company-b", "other.md"))).toEqual(Buffer.from("other\n"));
      expect(calls.map(({ args }) => args[0])).toEqual(["fetch", "show-ref", "checkout", "merge", "status", "ls-files", "add", "status", "commit", "rev-parse", "push"]);
      expect(calls[1]).toEqual({ cwd: workDir, args: ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`] });
      expect(calls[2]).toEqual({ cwd: workDir, args: ["checkout", branch] });
      expect(calls[3]).toEqual({ cwd: workDir, args: ["merge", "--ff-only", "FETCH_HEAD"] });
      expect(calls[4]).toEqual({ cwd: workDir, args: ["status", "--porcelain", "-z", "--untracked-files=all"] });
      expect(calls[5]).toEqual({ cwd: workDir, args: ["ls-files", "-z"] });
      expect(calls[6]).toEqual({ cwd: workDir, args: ["add", "-A"] });
      expect(calls[10]).toEqual({ cwd: workDir, args: ["push", "origin", `HEAD:${branch}`] });
    });
  });
});
