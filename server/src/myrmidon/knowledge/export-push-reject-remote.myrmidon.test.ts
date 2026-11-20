import { execFile } from "node:child_process";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createSystemGitRunner, publishKnowledgeExport } from "./git-export-git.js";
import type { KnowledgeGitTree } from "./git-export.js";

const exec = promisify(execFile);
const branch = "knowledge-export";
const ref = `refs/heads/${branch}`;

function tree(content: string): KnowledgeGitTree {
  return { files: [{ path: "ops/runbook.md", content }], contentHash: "fixture-hash", pageCount: 1, excludedLifePages: 0 };
}

describe("knowledge export rejected remote push", () => {
  it("reports rejection without changing the remote and publishes on a fresh retry", async () => {
    const root = await mkdtemp(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), "knowledge-reject-git-"));
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "empty-config"),
      GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test", GIT_CONFIG_COUNT: "0",
    };
    const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd, env, timeout: 10_000 })).stdout.trim();
    const bare = path.join(root, "remote.git");
    const hook = path.join(bare, "hooks", "pre-receive");
    const original = "original runbook\n";
    const updated = "updated runbook\nsecond line\n";
    try {
      await git(root, "init", "--bare", bare);
      const runner = createSystemGitRunner(10_000);
      const publish = (checkout: string, content: string) => publishKnowledgeExport({
        workDir: path.join(root, checkout), repoUrl: bare, branch, tree: tree(content), pathPrefix: "company-a", runner, env,
      });
      const bytes = async () => (await exec("git", ["show", `${ref}:company-a/ops/runbook.md`], { cwd: bare, env, timeout: 10_000, encoding: "buffer" })).stdout;
      const first = await publish("checkout-a", original);
      const firstSha = await git(bare, "rev-parse", "--verify", ref);
      expect(first.committed).toBe(true);
      expect(first.commit).toBe(firstSha);
      expect(await bytes()).toEqual(Buffer.from(original));

      await writeFile(hook, "#!/bin/sh\necho synthetic-rejection >&2\nexit 1\n", { mode: 0o755 });
      await expect(publish("checkout-b", updated)).rejects.toThrow("synthetic-rejection");
      expect(await git(bare, "rev-parse", "--verify", ref)).toBe(firstSha);
      expect(await bytes()).toEqual(Buffer.from(original));

      await unlink(hook);
      const retry = await publish("checkout-c", updated);
      const retrySha = await git(bare, "rev-parse", "--verify", ref);
      expect(retry.committed).toBe(true);
      expect(retry.commit).toBe(retrySha);
      expect(retrySha).not.toBe(firstSha);
      expect(await bytes()).toEqual(Buffer.from(updated));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
