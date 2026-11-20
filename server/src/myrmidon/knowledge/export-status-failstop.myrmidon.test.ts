import { mkdtemp, readFile, rm } from "node:fs/promises";
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

type Status = "failure" | "clean" | "dirty";

async function exercise(status: Status) {
  const root = await mkdtemp(path.join(process.env.MYRMIDON_RUN_SCRATCH_DIR || process.env.MYRMIDON_SCRATCH_DIR || homedir(), "myrmidon-status-"));
  const workDir = path.join(root, "checkout");
  const calls: string[][] = [];
  const runner: GitExportRunner = {
    async git(_cwd, args) {
      calls.push([...args]);
      if (args[0] === "status" && status === "failure") throw new Error("status failed");
      return {
        stdout: args[0] === "status" && status === "dirty" ? "A  ops/runbook.md\n" : args[0] === "rev-parse" ? `${commit}\n` : "",
        stderr: "",
      };
    },
  };
  const prefix = [
    ["ls-remote", "--heads", repoUrl, branch],
    ["init", "-b", branch],
    ["remote", "add", "origin", repoUrl],
    ["ls-files", "-z"],
    ["add", "-A"],
    ["status", "--porcelain"],
  ];
  try {
    const publication = publishKnowledgeExport({ workDir, repoUrl, branch, tree, runner });
    if (status === "failure") {
      await expect(publication).rejects.toThrow("status failed");
      expect(calls).toEqual(prefix);
    } else {
      await expect(publication).resolves.toEqual({
        committed: status === "dirty", commit: status === "dirty" ? commit : null,
        contentHash: tree.contentHash, pageCount: 1,
      });
      expect(calls).toEqual(status === "clean" ? prefix : [
        ...prefix,
        ["commit", "--allow-empty-message", "-m", "myrmidon(KNOWLEDGE-2.0 L-8): export 1 pages fixture-cont"],
        ["rev-parse", "HEAD"],
        ["push", "origin", `HEAD:${branch}`],
      ]);
    }
    expect(await readFile(path.join(workDir, "ops/runbook.md"))).toEqual(Buffer.from("Runbook\n", "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("knowledge export status failure", () => {
  it("propagates a status failure after staging without committing or pushing", async () => exercise("failure"));
  it("returns the exact clean result without committing or pushing", async () => exercise("clean"));
  it("commits and pushes a dirty result", async () => exercise("dirty"));
});
