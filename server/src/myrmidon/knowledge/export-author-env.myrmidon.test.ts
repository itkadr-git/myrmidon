import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { commitKnowledgeTreeIfChanged, publishKnowledgeExport, type GitExportRunner } from "./git-export-git.js";
import { KNOWLEDGE_EXPORT_AUTHOR_EMAIL, KNOWLEDGE_EXPORT_AUTHOR_NAME, type KnowledgeGitTree } from "./git-export.js";

const branch = "knowledge-export";
const sha = "0123456789abcdef0123456789abcdef01234567";
const tree: KnowledgeGitTree = {
  files: [{ path: "ops/runbook.md", content: "Runbook\nSecond line\n" }],
  contentHash: "fixture-content-hash",
  pageCount: 1,
  excludedLifePages: 0,
};
const callerEnv = () => ({
  GIT_AUTHOR_NAME: "Caller author",
  GIT_AUTHOR_EMAIL: "author@example.test",
  GIT_COMMITTER_NAME: "Caller committer",
  GIT_COMMITTER_EMAIL: "committer@example.test",
  EXPORT_MARKER: "safe-fixture-marker",
});

function recordingRunner(dirty: boolean) {
  const calls: { args: string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
  const runner: GitExportRunner = {
    async git(_cwd, args, env) {
      calls.push({ args: [...args], env: env && { ...env } });
      return { stdout: args[0] === "status" && dirty ? "A  ops/runbook.md\n" : args[0] === "rev-parse" ? `${sha}\n` : "", stderr: "" };
    },
  };
  return { runner, calls };
}

async function withWorkspace(run: (dir: string) => Promise<void>) {
  const root = await mkdtemp(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || homedir(), "knowledge-author-env-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("knowledge export author environment", () => {
  it("overrides conflicting identity for commit and HEAD without mutating caller env", async () => {
    await withWorkspace(async (dir) => {
      const env = callerEnv();
      const original = { ...env };
      const { runner, calls } = recordingRunner(true);
      expect(await commitKnowledgeTreeIfChanged(runner, dir, branch, tree, env)).toEqual({ committed: true, commit: sha });
      expect(await readFile(path.join(dir, "ops/runbook.md"))).toEqual(Buffer.from(tree.files[0].content));
      const identityCalls = calls.filter(({ args }) => args[0] === "commit" || args[0] === "rev-parse");
      expect(identityCalls.map(({ args }) => args[0])).toEqual(["commit", "rev-parse"]);
      for (const call of identityCalls) {
        expect(call.env).toEqual({
          ...original,
          GIT_AUTHOR_NAME: KNOWLEDGE_EXPORT_AUTHOR_NAME,
          GIT_AUTHOR_EMAIL: KNOWLEDGE_EXPORT_AUTHOR_EMAIL,
          GIT_COMMITTER_NAME: KNOWLEDGE_EXPORT_AUTHOR_NAME,
          GIT_COMMITTER_EMAIL: KNOWLEDGE_EXPORT_AUTHOR_EMAIL,
        });
      }
      expect(env).toEqual(original);
    });
  });

  it("does not commit or read HEAD when status is clean", async () => {
    await withWorkspace(async (dir) => {
      const { runner, calls } = recordingRunner(false);
      expect(await commitKnowledgeTreeIfChanged(runner, dir, branch, tree, callerEnv())).toEqual({ committed: false, commit: null });
      expect(await readFile(path.join(dir, "ops/runbook.md"))).toEqual(Buffer.from(tree.files[0].content));
      expect(calls.map(({ args }) => args[0])).toEqual(["ls-files", "add", "status"]);
    });
  });

  it("passes the caller marker to push without logging it", async () => {
    await withWorkspace(async (dir) => {
      const env = callerEnv();
      const original = { ...env };
      const { runner, calls } = recordingRunner(true);
      const log = vi.spyOn(console, "log");
      const warn = vi.spyOn(console, "warn");
      const error = vi.spyOn(console, "error");
      try {
        const result = await publishKnowledgeExport({ workDir: dir, repoUrl: "https://example.test/knowledge.git", branch, tree, runner, env });
        expect(result).toEqual({ committed: true, commit: sha, contentHash: tree.contentHash, pageCount: 1 });
        const pushes = calls.filter(({ args }) => args[0] === "push");
        expect(pushes).toHaveLength(1);
        expect(pushes[0]).toEqual({ args: ["push", "origin", `HEAD:${branch}`], env: original });
        expect(await readFile(path.join(dir, "ops/runbook.md"))).toEqual(Buffer.from(tree.files[0].content));
        expect(env).toEqual(original);
        expect(JSON.stringify([log.mock.calls, warn.mock.calls, error.mock.calls])).not.toContain(env.EXPORT_MARKER);
      } finally {
        log.mockRestore();
        warn.mockRestore();
        error.mockRestore();
      }
    });
  });
});
