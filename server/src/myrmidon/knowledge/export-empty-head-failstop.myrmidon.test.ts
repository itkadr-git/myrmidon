import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function exercise(status: string, head: string, invalid: boolean) {
  const root = await mkdtemp(path.join(process.env.MYRMIDON_RUN_SCRATCH_DIR || process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.TMPDIR || homedir(), "knowledge-empty-head-"));
  const workDir = path.join(root, "checkout");
  const sentinel = Buffer.from([0, 255, 13, 10]);
  const sentinelPath = path.join(root, "sentinel");
  await writeFile(sentinelPath, sentinel);
  const calls: string[][] = [];
  const runner: GitExportRunner = {
    async git(_cwd, args) {
      calls.push([...args]);
      return { stdout: args[0] === "status" ? status : args[0] === "rev-parse" ? head : "", stderr: "" };
    },
  };
  try {
    const publication = publishKnowledgeExport({ workDir, repoUrl, branch, tree, runner });
    if (invalid) {
      await expect(publication).rejects.toThrow(/empty.*HEAD|HEAD.*empty/i);
    } else {
      await expect(publication).resolves.toEqual({ committed: Boolean(status), commit: status ? sha : null, contentHash: tree.contentHash, pageCount: 1 });
    }
    expect(await readFile(path.join(workDir, "ops/runbook.md"))).toEqual(Buffer.from("Runbook\n"));
    expect(await readFile(sentinelPath)).toEqual(sentinel);
    expect(calls).toEqual([
      ["ls-remote", "--heads", repoUrl, branch],
      ["init", "-b", branch],
      ["remote", "add", "origin", repoUrl],
      ["ls-files", "-z"],
      ["add", "-A"],
      ["status", "--porcelain"],
      ...(status ? [
        ["commit", "--allow-empty-message", "-m", knowledgeExportCommitMessage(tree)],
        ["rev-parse", "HEAD"],
        ...(invalid ? [] : [["push", "origin", `HEAD:${branch}`]]),
      ] : []),
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("knowledge export empty HEAD fail-stop", () => {
  it.each(["", " \t\n"])("rejects successful rev-parse with empty or whitespace stdout (%j) before push", async (head) => {
    await exercise("A  ops/runbook.md\n", head, true);
  });

  it("returns a valid HEAD and pushes once", async () => {
    await exercise("A  ops/runbook.md\n", ` ${sha}\n`, false);
  });

  it("does not resolve HEAD or push a clean tree", async () => {
    await exercise("", `${sha}\n`, false);
  });
});
