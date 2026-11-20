import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
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

type Mode = "empty" | "remote" | "existing";
type Failure = "ls-remote" | "clone" | "push";

async function withWorkspace(run: (root: string, workDir: string) => Promise<void>) {
  const root = await mkdtemp(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), "knowledge-publish-"));
  try {
    await run(root, path.join(root, "checkout"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function recordingRunner(mode: Mode, dirty: boolean, fail?: Failure) {
  const calls: { cwd: string; args: string[] }[] = [];
  const runner: GitExportRunner = {
    async git(cwd, args) {
      calls.push({ cwd, args: [...args] });
      if (args[0] === fail) throw new Error(`${fail} failed`);
      if (args[0] === "clone") {
        const destination = args[args.length - 1];
        await mkdir(path.join(destination, ".git"), { recursive: true });
        await writeFile(path.join(destination, ".git", "HEAD"), "ref: refs/heads/knowledge-export\n");
      }
      const stdout = args[0] === "ls-remote" && mode === "remote" ? `${commit}\trefs/heads/${branch}\n`
        : args[0] === "status" && dirty ? "A  ops/runbook.md\n"
        : args[0] === "rev-parse" ? `${commit}\n` : "";
      return { stdout, stderr: "" };
    },
  };
  return { runner, calls };
}

async function setupExisting(workDir: string) {
  await mkdir(path.join(workDir, ".git"), { recursive: true });
  await writeFile(path.join(workDir, ".git", "HEAD"), "ref: refs/heads/knowledge-export\n");
}

function commands(calls: { args: string[] }[]) {
  return calls.map(({ args }) => args[0]);
}

describe("knowledge export publication branches", () => {
  it.each(["empty", "remote", "existing"] as const)("publishes dirty tree from %s", async (mode) => {
    await withWorkspace(async (root, workDir) => {
      if (mode === "existing") await setupExisting(workDir);
      const { runner, calls } = recordingRunner(mode, true);
      const result = await publishKnowledgeExport({ workDir, repoUrl, branch, tree, runner });
      expect(result).toEqual({ committed: true, commit, contentHash: tree.contentHash, pageCount: 1 });
      expect(await readFile(path.join(workDir, "ops/runbook.md"), "utf8")).toBe("Runbook\n");
      const prefix = mode === "empty" ? ["ls-remote", "init", "remote"] : mode === "remote" ? ["ls-remote", "clone"] : ["fetch", "show-ref", "checkout", "merge"];
      expect(commands(calls)).toEqual([...prefix, "ls-files", "add", "status", "commit", "rev-parse", "push"]);
      if (mode === "empty") {
        expect(calls[0]).toEqual({ cwd: workDir, args: ["ls-remote", "--heads", repoUrl, branch] });
        expect(calls[1]).toEqual({ cwd: workDir, args: ["init", "-b", branch] });
        expect(calls[2]).toEqual({ cwd: workDir, args: ["remote", "add", "origin", repoUrl] });
      } else if (mode === "remote") {
        expect(calls[1]).toEqual({ cwd: root, args: ["clone", "--branch", branch, "--single-branch", "--", repoUrl, workDir] });
        expect(await readFile(path.join(workDir, ".git", "HEAD"), "utf8")).toContain(branch);
      } else {
        expect(calls[0]).toEqual({ cwd: workDir, args: ["fetch", "origin", branch] });
      }
      expect(calls.filter(({ args }) => args[0] === "push")).toEqual([{ cwd: workDir, args: ["push", "origin", `HEAD:${branch}`] }]);
      expect(calls.find(({ args }) => args[0] === "rev-parse")?.args).toEqual(["rev-parse", "HEAD"]);
    });
  });

  it.each(["empty", "remote", "existing"] as const)("does not commit or push a clean tree from %s", async (mode) => {
    await withWorkspace(async (_root, workDir) => {
      if (mode === "existing") await setupExisting(workDir);
      const { runner, calls } = recordingRunner(mode, false);
      const result = await publishKnowledgeExport({ workDir, repoUrl, branch, tree, runner });
      expect(result).toEqual({ committed: false, commit: null, contentHash: tree.contentHash, pageCount: 1 });
      const prefix = mode === "empty" ? ["ls-remote", "init", "remote"] : mode === "remote" ? ["ls-remote", "clone"] : ["fetch", "show-ref", "checkout", "merge"];
      expect(commands(calls)).toEqual([...prefix, "ls-files", "add", "status"]);
      expect(await readFile(path.join(workDir, "ops/runbook.md"), "utf8")).toBe("Runbook\n");
    });
  });

  it.each([
    { fail: "ls-remote", mode: "remote", expected: ["ls-remote"] },
    { fail: "clone", mode: "remote", expected: ["ls-remote", "clone"] },
    { fail: "push", mode: "empty", expected: ["ls-remote", "init", "remote", "ls-files", "add", "status", "commit", "rev-parse", "push"] },
  ] as const)("propagates $fail failure and stops", async ({ fail, mode, expected }) => {
    await withWorkspace(async (_root, workDir) => {
      const { runner, calls } = recordingRunner(mode, true, fail);
      await expect(publishKnowledgeExport({ workDir, repoUrl, branch, tree, runner })).rejects.toThrow(`${fail} failed`);
      expect(commands(calls)).toEqual(expected);
    });
  });
});
