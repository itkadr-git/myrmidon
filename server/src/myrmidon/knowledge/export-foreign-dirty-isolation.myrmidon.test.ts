import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { commitKnowledgeTreeIfChanged, createSystemGitRunner } from "./git-export-git.js";
import type { KnowledgeGitTree } from "./git-export.js";

const exec = promisify(execFile);

describe("knowledge export foreign dirty isolation", () => {
  it("fails before changing the checkout when another company has uncommitted bytes", async () => {
    const root = await mkdtemp(path.join(process.env.MYRMIDON_RUN_SCRATCH_DIR || process.env.MYRMIDON_SCRATCH_DIR || homedir(), "myrmidon-foreign-dirty-"));
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "empty-config"),
      GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "0", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test",
    };
    const git = async (...args: string[]) => (await exec("git", args, { cwd: root, env, timeout: 10_000 })).stdout;
    try {
      await git("init", "-b", "knowledge-export");
      await mkdir(path.join(root, "company-b"));
      const sentinel = path.join(root, "company-b", "sentinel.md");
      await writeFile(sentinel, "original B\n");
      await git("add", "company-b/sentinel.md");
      await git("commit", "-m", "seed");
      const originalSha = (await git("rev-parse", "HEAD")).trim();
      await writeFile(sentinel, "dirty B\n");
      const originalDiff = await git("diff", "--", "company-b/sentinel.md");
      expect(originalDiff).toContain("+dirty B");
      const tree: KnowledgeGitTree = { files: [{ path: "page.md", content: "company A\n" }], contentHash: "fixture", pageCount: 1, excludedLifePages: 0 };
      const outcome = await commitKnowledgeTreeIfChanged(createSystemGitRunner(10_000), root, "knowledge-export", tree, env, "company-a")
        .catch((error: Error) => error);
      expect(await git("show", "HEAD:company-b/sentinel.md")).toBe("original B\n");
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toMatch(/knowledge export:.*dirty checkout/i);
      expect((await git("rev-parse", "HEAD")).trim()).toBe(originalSha);
      expect(await readFile(sentinel, "utf8")).toBe("dirty B\n");
      expect(await git("diff", "--", "company-b/sentinel.md")).toBe(originalDiff);
      await expect(readFile(path.join(root, "company-a", "page.md"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
