import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { publishKnowledgeExport, type GitExportRunner } from "./git-export-git.js";
import type { KnowledgeGitTree } from "./git-export.js";

const branch = "knowledge-export";
const tree: KnowledgeGitTree = {
  files: [{ path: "old.md", content: "replacement\n" }, { path: "new.md", content: "new\n" }],
  contentHash: "fixture-hash",
  pageCount: 2,
  excludedLifePages: 0,
};

async function withCheckout(run: (workDir: string) => Promise<void>) {
  const root = await mkdtemp(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), "knowledge-fetch-"));
  try {
    const workDir = path.join(root, "checkout");
    await mkdir(path.join(workDir, ".git"), { recursive: true });
    await writeFile(path.join(workDir, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
    await writeFile(path.join(workDir, "old.md"), "old\n");
    await writeFile(path.join(workDir, "sentinel.md"), "sentinel\n");
    await run(workDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runnerFor(fetchFailure?: string) {
  const calls: string[][] = [];
  const runner: GitExportRunner = {
    async git(_cwd, args) {
      calls.push([...args]);
      if (args[0] === "fetch" && fetchFailure) throw new Error(fetchFailure);
      return { stdout: args[0] === "status" ? " M old.md\n" : args[0] === "rev-parse" ? "abc123\n" : "", stderr: "" };
    },
  };
  return { runner, calls };
}

const repoUrl = "https://example.test/knowledge.git";

describe("knowledge export fetch fail-stop", () => {
  it.each([
    ["authentication", "fatal: Authentication failed for https://user:password@example.test/repo"],
    ["network", "fatal: unable to access repository: Could not resolve host"],
    ["timeout", "git fetch timed out"],
    ["ambiguous not found", "fatal: repository not found"],
    ["missing remote branch", `fatal: couldn't find remote ref ${branch}`],
  ])("fails closed on %s without filesystem writes or later git operations", async (_name, failure) => {
    await withCheckout(async (workDir) => {
      const { runner, calls } = runnerFor(failure);
      const result = publishKnowledgeExport({ workDir, repoUrl, branch, tree, runner });
      const safeMessage = failure.replace("user:password@", "<redacted>@");
      await expect(result).rejects.toThrow(safeMessage);
      expect(calls).toEqual([["fetch", "origin", branch]]);
      expect(await readdir(workDir)).toEqual([".git", "old.md", "sentinel.md"]);
      expect(await readFile(path.join(workDir, "old.md"), "utf8")).toBe("old\n");
      expect(await readFile(path.join(workDir, "sentinel.md"), "utf8")).toBe("sentinel\n");
      expect(await readFile(path.join(workDir, ".git", "HEAD"), "utf8")).toBe(`ref: refs/heads/${branch}\n`);
    });
  });

  it("continues to write, commit and push after a successful fetch", async () => {
    await withCheckout(async (workDir) => {
      const { runner, calls } = runnerFor();
      const result = await publishKnowledgeExport({ workDir, repoUrl, branch, tree, runner });
      expect(result.committed).toBe(true);
      expect(await readFile(path.join(workDir, "old.md"), "utf8")).toBe("replacement\n");
      expect(await readFile(path.join(workDir, "new.md"), "utf8")).toBe("new\n");
      expect(calls.map((args) => args[0])).toEqual(["fetch", "show-ref", "checkout", "merge", "ls-files", "add", "status", "commit", "rev-parse", "push"]);
    });
  });
});
