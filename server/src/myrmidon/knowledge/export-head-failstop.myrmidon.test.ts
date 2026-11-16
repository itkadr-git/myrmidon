import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { publishKnowledgeExport, type GitExportRunner } from "./git-export-git.js";
import { knowledgeExportCommitMessage, type KnowledgeGitTree } from "./git-export.js";

const repoUrl = "https://example.test/knowledge.git";
const branch = "knowledge-export";
const sha = "0123456789abcdef0123456789abcdef01234567";
const tree: KnowledgeGitTree = {
  files: [{ path: "ops/runbook.md", content: "Runbook\n" }],
  contentHash: "fixture-content-hash-1234567890",
  pageCount: 1,
  excludedLifePages: 0,
};

async function exercise(failHead: boolean) {
  const root = await mkdtemp(path.join(process.env.MYRMIDON_RUN_SCRATCH_DIR || process.env.MYRMIDON_SCRATCH_DIR || homedir(), "myrmidon-head-"));
  const workDir = path.join(root, "checkout");
  const calls: string[][] = [];
  const runner: GitExportRunner = {
    async git(_cwd, args) {
      calls.push([...args]);
      if (args[0] === "rev-parse" && failHead) throw new Error("HEAD lookup failed");
      return { stdout: args[0] === "status" ? "A  ops/runbook.md\n" : args[0] === "rev-parse" ? `${sha}\n` : "", stderr: "" };
    },
  };
  try {
    const publication = publishKnowledgeExport({ workDir, repoUrl, branch, tree, runner });
    if (failHead) {
      await expect(publication).rejects.toThrow("HEAD lookup failed");
    } else {
      await expect(publication).resolves.toEqual({ committed: true, commit: sha, contentHash: tree.contentHash, pageCount: 1 });
    }
    expect(await readFile(path.join(workDir, "ops/runbook.md"))).toEqual(Buffer.from("Runbook\n"));
    expect(calls).toEqual([
      ["ls-remote", "--heads", repoUrl, branch],
      ["init", "-b", branch],
      ["remote", "add", "origin", repoUrl],
      ["ls-files", "-z"],
      ["add", "-A"],
      ["status", "--porcelain"],
      ["commit", "--allow-empty-message", "-m", knowledgeExportCommitMessage(tree)],
      ["rev-parse", "HEAD"],
      ...(failHead ? [] : [["push", "origin", `HEAD:${branch}`]]),
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("knowledge export HEAD fail-stop", () => {
  it("propagates HEAD lookup failure after commit without pushing", async () => {
    await exercise(true);
  });

  it("trims the returned HEAD and pushes after a successful lookup", async () => {
    await exercise(false);
  });
});
