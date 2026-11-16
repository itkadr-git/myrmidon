import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { publishKnowledgeExport, type GitExportRunner } from "./git-export-git.js";
import type { KnowledgeGitTree } from "./git-export.js";

const repoUrl = "https://example.test/knowledge.git";
const branch = "knowledge-export";
const commit = "0123456789abcdef0123456789abcdef01234567";
const tree: KnowledgeGitTree = {
  files: [{ path: "ops/runbook.md", content: "First publish\n" }],
  contentHash: "fixture-hash", pageCount: 1, excludedLifePages: 0,
};

async function withWorkspace(run: (workDir: string) => Promise<void>) {
  const base = process.env.MYRMIDON_RUN_SCRATCH_DIR || process.env.MYRMIDON_SCRATCH_DIR || homedir();
  const root = await mkdtemp(path.join(base, "myrmidon-remoteadd-"));
  try {
    await run(path.join(root, "checkout"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function recordingRunner(failRemote: boolean) {
  const calls: { cwd: string; args: string[] }[] = [];
  const runner: GitExportRunner = {
    async git(cwd, args) {
      calls.push({ cwd, args: [...args] });
      if (args[0] === "init") {
        await mkdir(path.join(cwd, ".git"));
        await writeFile(path.join(cwd, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
      }
      if (args[0] === "remote" && failRemote) throw new Error("remote add rejected");
      return { stdout: args[0] === "status" ? "A  ops/runbook.md\n" : args[0] === "rev-parse" ? `${commit}\n` : "", stderr: "" };
    },
  };
  return { runner, calls };
}

function initialCalls(workDir: string) {
  return [
    { cwd: workDir, args: ["ls-remote", "--heads", repoUrl, branch] },
    { cwd: workDir, args: ["init", "-b", branch] },
    { cwd: workDir, args: ["remote", "add", "origin", repoUrl] },
  ];
}

describe("knowledge export remote add failure", () => {
  it("propagates remote add failure before writing or staging the tree", async () => {
    await withWorkspace(async (workDir) => {
      const { runner, calls } = recordingRunner(true);
      await expect(publishKnowledgeExport({ workDir, repoUrl, branch, tree, runner })).rejects.toThrow("remote add rejected");
      expect(calls).toEqual(initialCalls(workDir));
      await expect(readFile(path.join(workDir, "ops/runbook.md"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(path.join(workDir, ".git", "HEAD"), "utf8")).toBe(`ref: refs/heads/${branch}\n`);
    });
  });

  it("publishes the first tree to origin and the requested branch when remote add succeeds", async () => {
    await withWorkspace(async (workDir) => {
      const { runner, calls } = recordingRunner(false);
      const result = await publishKnowledgeExport({ workDir, repoUrl, branch, tree, runner });
      expect(result).toEqual({ committed: true, commit, contentHash: tree.contentHash, pageCount: 1 });
      expect(await readFile(path.join(workDir, "ops/runbook.md"))).toEqual(Buffer.from("First publish\n"));
      expect(calls.slice(0, 3)).toEqual(initialCalls(workDir));
      expect(calls.slice(3).map(({ args }) => args[0])).toEqual(["ls-files", "add", "status", "commit", "rev-parse", "push"]);
      expect(calls.at(-1)).toEqual({ cwd: workDir, args: ["push", "origin", `HEAD:${branch}`] });
    });
  });
});
