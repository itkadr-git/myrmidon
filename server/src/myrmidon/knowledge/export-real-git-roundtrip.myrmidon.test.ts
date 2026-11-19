import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createSystemGitRunner, publishKnowledgeExport } from "./git-export-git.js";
import { KNOWLEDGE_EXPORT_AUTHOR_EMAIL, KNOWLEDGE_EXPORT_AUTHOR_NAME, type KnowledgeGitTree } from "./git-export.js";

const exec = promisify(execFile);
const branch = "knowledge-export";
const ref = `refs/heads/${branch}`;

function tree(content: string): KnowledgeGitTree {
  return { files: [{ path: "ops/runbook.md", content }], contentHash: "fixture-hash", pageCount: 1, excludedLifePages: 0 };
}

describe("knowledge export real git roundtrip", () => {
  it("publishes fresh checkouts idempotently without changing a sibling branch", async () => {
    const root = await mkdtemp(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), "knowledge-real-git-"));
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "empty-config"),
      GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test",
      GIT_CONFIG_COUNT: "0",
    };
    const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd, env, timeout: 10_000 })).stdout.trim();
    const bare = path.join(root, "remote.git");
    try {
      await git(root, "init", "--bare", bare);
      const seed = path.join(root, "seed");
      await mkdir(seed);
      await git(seed, "init", "-b", "sentinel");
      await writeFile(path.join(seed, "sentinel.txt"), "untouched\n");
      await git(seed, "add", "sentinel.txt");
      await git(seed, "commit", "-m", "sentinel");
      await git(seed, "push", bare, "HEAD:refs/heads/sentinel");
      const sentinel = await git(bare, "rev-parse", "refs/heads/sentinel");
      const runner = createSystemGitRunner(10_000);
      const publish = (checkout: string, content: string) => publishKnowledgeExport({
        workDir: path.join(root, checkout), repoUrl: bare, branch, tree: tree(content), pathPrefix: "company-a", runner, env,
      });
      const first = await publish("checkout-a", "original\n");
      const firstSha = await git(bare, "rev-parse", "--verify", ref);
      expect(first.committed).toBe(true);
      expect(first.commit).toBe(firstSha);
      expect(await git(bare, "rev-list", "--count", ref)).toBe("1");
      expect(await git(bare, "show", "-s", "--format=%an%n%ae%n%cn%n%ce", ref)).toBe(
        [KNOWLEDGE_EXPORT_AUTHOR_NAME, KNOWLEDGE_EXPORT_AUTHOR_EMAIL, KNOWLEDGE_EXPORT_AUTHOR_NAME, KNOWLEDGE_EXPORT_AUTHOR_EMAIL].join("\n"),
      );
      const second = await publish("checkout-b", "original\n");
      expect(second.committed).toBe(false);
      expect(second.commit).toBeNull();
      expect(await git(bare, "rev-parse", "--verify", ref)).toBe(firstSha);
      expect(await git(bare, "rev-list", "--count", ref)).toBe("1");
      const updated = "updated runbook\nsecond line\n";
      const third = await publish("checkout-c", updated);
      const thirdSha = await git(bare, "rev-parse", "--verify", ref);
      expect(third.committed).toBe(true);
      expect(third.commit).toBe(thirdSha);
      expect(thirdSha).not.toBe(firstSha);
      expect(await git(bare, "rev-list", "--count", ref)).toBe("2");
      const shown = await exec("git", ["show", `${ref}:company-a/ops/runbook.md`], { cwd: bare, env, timeout: 10_000, encoding: "buffer" });
      expect(shown.stdout).toEqual(Buffer.from(updated));
      expect(await git(bare, "rev-parse", "refs/heads/sentinel")).toBe(sentinel);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
