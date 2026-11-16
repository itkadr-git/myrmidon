import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { publishKnowledgeExport, type GitExportRunner } from "./git-export-git.js";
import type { KnowledgeGitTree } from "./git-export.js";

const branch = "knowledge-export";
const repoUrl = "https://synthetic-user:synthetic-password@example.test/knowledge.git";
const tree: KnowledgeGitTree = {
  files: [{ path: "page.md", content: "exported\n" }],
  contentHash: "fixture-hash",
  pageCount: 1,
  excludedLifePages: 0,
};

async function withFreshCheckout(run: (workDir: string) => Promise<void>) {
  const root = await mkdtemp(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), "knowledge-clone-"));
  try {
    await run(path.join(root, "checkout"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runnerFor(cloneFailure?: string) {
  const calls: string[][] = [];
  const runner: GitExportRunner = {
    async git(_cwd, args) {
      calls.push([...args]);
      if (args[0] === "clone") {
        if (cloneFailure) throw new Error(cloneFailure);
        await mkdir(args[args.length - 1]!, { recursive: true });
      }
      return {
        stdout: args[0] === "ls-remote" ? `abc123\trefs/heads/${branch}\n`
          : args[0] === "status" ? "?? page.md\n"
            : args[0] === "rev-parse" ? "abc123\n" : "",
        stderr: "",
      };
    },
  };
  return { runner, calls };
}

describe("knowledge export clone fail-stop", () => {
  it.each([
    ["authentication", `fatal: Authentication failed for ${repoUrl}`],
    ["network", `fatal: unable to access ${repoUrl}: Could not resolve host`],
  ])("rejects %s clone failure without writing or running subsequent git commands", async (_name, failure) => {
    await withFreshCheckout(async (workDir) => {
      const { runner, calls } = runnerFor(failure);
      const result = publishKnowledgeExport({ workDir, repoUrl, branch, tree, runner });
      await expect(result).rejects.toThrow(failure.replace("synthetic-user:synthetic-password@", "<redacted>@"));
      const error = await result.catch((err: unknown) => err);
      if (!(error instanceof Error)) throw new Error("Expected clone to reject with an Error");
      expect(error.message).not.toContain("synthetic-user");
      expect(error.message).not.toContain("synthetic-password");
      expect(calls.map((args) => args[0])).toEqual(["ls-remote", "clone"]);
      expect(await readdir(path.dirname(workDir))).toEqual([]);
    });
  });

  it("writes and commits the export after a successful clone", async () => {
    await withFreshCheckout(async (workDir) => {
      const { runner, calls } = runnerFor();
      const result = await publishKnowledgeExport({ workDir, repoUrl, branch, tree, runner });
      expect(result.committed).toBe(true);
      expect(await readFile(path.join(workDir, "page.md"), "utf8")).toBe("exported\n");
      expect(calls.map((args) => args[0])).toEqual(["ls-remote", "clone", "ls-files", "add", "status", "commit", "rev-parse", "push"]);
    });
  });
});
