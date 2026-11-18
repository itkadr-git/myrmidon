import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { publishKnowledgeExport, type GitExportRunner } from "./git-export-git.js";
import type { KnowledgeGitTree } from "./git-export.js";

const branch = "knowledge-export";
const repoUrl = "https://example.test/knowledge.git";
const tree: KnowledgeGitTree = {
  files: [{ path: "page.md", content: "exported\n" }],
  contentHash: "fixture-hash",
  pageCount: 1,
  excludedLifePages: 0,
};

async function withCheckout(run: (workDir: string) => Promise<void>) {
  const base = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const root = await mkdtemp(path.join(base, "knowledge-remote-probe-"));
  try {
    const workDir = path.join(root, "checkout");
    await mkdir(workDir);
    await run(workDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function recordingRunner(workDir: string, probe: string | Error) {
  const calls: { cwd: string; args: string[] }[] = [];
  const runner: GitExportRunner = {
    async git(cwd, args) {
      calls.push({ cwd, args: [...args] });
      if (args[0] === "ls-remote") {
        if (probe instanceof Error) throw probe;
        return { stdout: probe, stderr: "" };
      }
      if (args[0] === "clone") await mkdir(workDir);
      return { stdout: args[0] === "status" ? "?? page.md\n" : args[0] === "rev-parse" ? "abc123\n" : "", stderr: "" };
    },
  };
  return { runner, calls };
}

describe("knowledge export remote probe fail-stop", () => {
  it.each([
    ["access denied", "fatal: access denied"],
    ["remote unavailable", "fatal: could not resolve host example.test"],
  ])("preserves checkout on %s and performs no subsequent git operations", async (_name, message) => {
    await withCheckout(async (workDir) => {
      const sentinel = Buffer.from([0, 255, 13, 10, 42]);
      await writeFile(path.join(workDir, "sentinel.bin"), sentinel);
      const { runner, calls } = recordingRunner(workDir, new Error(message));
      await expect(publishKnowledgeExport({ workDir, repoUrl, branch, tree, runner })).rejects.toThrow(message);
      expect(await readdir(workDir)).toEqual(["sentinel.bin"]);
      expect(await readFile(path.join(workDir, "sentinel.bin"))).toEqual(sentinel);
      expect(calls).toEqual([{ cwd: workDir, args: ["ls-remote", "--heads", repoUrl, branch] }]);
    });
  });

  it.each([true, false])("publishes after a successful probe (branch exists: %s)", async (exists) => {
    await withCheckout(async (workDir) => {
      const { runner, calls } = recordingRunner(workDir, exists ? `abc123\trefs/heads/${branch}\n` : "");
      const result = await publishKnowledgeExport({ workDir, repoUrl, branch, tree, runner });
      expect(result).toEqual({ committed: true, commit: "abc123", contentHash: tree.contentHash, pageCount: 1 });
      expect(await readFile(path.join(workDir, "page.md"), "utf8")).toBe("exported\n");
      expect(calls.slice(0, exists ? 2 : 3)).toEqual([
        { cwd: workDir, args: ["ls-remote", "--heads", repoUrl, branch] },
        ...(exists
          ? [{ cwd: path.dirname(workDir), args: ["clone", "--branch", branch, "--single-branch", "--", repoUrl, workDir] }]
          : [{ cwd: workDir, args: ["init", "-b", branch] }, { cwd: workDir, args: ["remote", "add", "origin", repoUrl] }]),
      ]);
      expect(calls.slice(exists ? 2 : 3).map(({ args }) => args[0])).toEqual(["ls-files", "add", "status", "commit", "rev-parse", "push"]);
    });
  });
});
