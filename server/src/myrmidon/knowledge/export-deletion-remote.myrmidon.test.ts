import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createSystemGitRunner, publishKnowledgeExport } from "./git-export-git.js";
import type { KnowledgeGitTree } from "./git-export.js";

const exec = promisify(execFile);
const branch = "knowledge-export";
const ref = `refs/heads/${branch}`;
const removedPath = "company-a/ops/removed.md";
const retainedPath = "company-a/ops/retained.md";
const retainedContent = "retained article\n";

function tree(includeRemoved: boolean): KnowledgeGitTree {
  const files = [{ path: "ops/retained.md", content: retainedContent }];
  if (includeRemoved) files.push({ path: "ops/removed.md", content: "removed article\n" });
  return { files, contentHash: includeRemoved ? "two-pages" : "one-page", pageCount: files.length, excludedLifePages: 0 };
}

describe("knowledge export deletion on remote", () => {
  it("commits a removed article and leaves an identical fresh export unchanged", async () => {
    const root = await mkdtemp(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), "knowledge-delete-git-"));
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "empty-config"),
      GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test", GIT_CONFIG_COUNT: "0",
    };
    const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd, env, timeout: 10_000 })).stdout.trim();
    const bare = path.join(root, "remote.git");
    try {
      await git(root, "init", "--bare", bare);
      const runner = createSystemGitRunner(10_000);
      const publish = (checkout: string, includeRemoved: boolean) => publishKnowledgeExport({
        workDir: path.join(root, checkout), repoUrl: bare, branch, tree: tree(includeRemoved), pathPrefix: "company-a", runner, env,
      });
      const first = await publish("checkout-a", true);
      const firstSha = await git(bare, "rev-parse", "--verify", ref);
      expect(first.committed).toBe(true);
      expect(first.commit).toBe(firstSha);
      expect(await git(bare, "ls-tree", "-r", "--name-only", ref)).toBe([removedPath, retainedPath].join("\n"));
      expect(await git(bare, "show", `${ref}:${removedPath}`)).toBe("removed article");

      const second = await publish("checkout-b", false);
      const secondSha = await git(bare, "rev-parse", "--verify", ref);
      expect(await git(bare, "ls-tree", "-r", "--name-only", ref)).toBe(retainedPath);
      await expect(git(bare, "show", `${ref}:${removedPath}`)).rejects.toThrow();
      expect(await git(bare, "show", `${ref}:${retainedPath}`)).toBe(retainedContent.trim());
      expect(second.committed).toBe(true);
      expect(second.commit).toBe(secondSha);
      expect(secondSha).not.toBe(firstSha);
      expect(await git(bare, "rev-parse", `${secondSha}^`)).toBe(firstSha);

      const third = await publish("checkout-c", false);
      expect(third.committed).toBe(false);
      expect(third.commit).toBeNull();
      expect(await git(bare, "rev-parse", "--verify", ref)).toBe(secondSha);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
