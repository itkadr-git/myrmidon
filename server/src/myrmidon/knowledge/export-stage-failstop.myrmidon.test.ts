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

async function exercise(failAdd: boolean) {
  const root = await mkdtemp(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), "knowledge-stage-"));
  const workDir = path.join(root, "checkout");
  const calls: string[][] = [];
  const runner: GitExportRunner = {
    async git(_cwd, args) {
      calls.push([...args]);
      if (args[0] === "add") {
        expect(await readFile(path.join(workDir, "ops/runbook.md"), "utf8")).toBe("Runbook\n");
        if (failAdd) throw new Error("synthetic add failure marker");
      }
      return { stdout: args[0] === "status" ? "A  ops/runbook.md\n" : args[0] === "rev-parse" ? `${commit}\n` : "", stderr: "" };
    },
  };
  try {
    const publication = publishKnowledgeExport({ workDir, repoUrl, branch, tree, runner });
    if (failAdd) {
      const outcome = await publication.then(() => null, (error: unknown) => error);
      expect(calls).toEqual([
        ["ls-remote", "--heads", repoUrl, branch], ["init", "-b", branch],
        ["remote", "add", "origin", repoUrl], ["ls-files", "-z"], ["add", "-A"],
      ]);
      expect(calls.some(([command]) => ["status", "commit", "rev-parse", "push"].includes(command))).toBe(false);
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toContain("synthetic add failure marker");
    } else {
      await expect(publication).resolves.toEqual({ committed: true, commit, contentHash: tree.contentHash, pageCount: 1 });
      expect(calls.map(([command]) => command)).toEqual(["ls-remote", "init", "remote", "ls-files", "add", "status", "commit", "rev-parse", "push"]);
      expect(calls.at(-1)).toEqual(["push", "origin", `HEAD:${branch}`]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("knowledge export staging fail-stop", () => {
  it("propagates add failure without status, commit or push", async () => {
    await exercise(true);
  });

  it("pushes the same tree when staging succeeds", async () => {
    await exercise(false);
  });
});
