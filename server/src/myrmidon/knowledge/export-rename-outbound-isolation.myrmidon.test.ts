import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { commitKnowledgeTreeIfChanged, createSystemGitRunner } from "./git-export-git.js";
import type { KnowledgeGitTree } from "./git-export.js";

const exec = promisify(execFile);
const branch = "knowledge-export";
const content = "owned page\n";

async function withRepository(run: (root: string, env: NodeJS.ProcessEnv, git: (...args: string[]) => Promise<string>) => Promise<void>) {
  const root = await mkdtemp(path.join(process.env.MYRMIDON_RUN_SCRATCH_DIR || process.env.MYRMIDON_SCRATCH_DIR || homedir(), "myrmidon-rename-"));
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "empty-config"),
    GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "0", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test",
  };
  const git = async (...args: string[]) => (await exec("git", args, { cwd: root, env, timeout: 10_000 })).stdout;
  try {
    await git("init", "-b", branch);
    await mkdir(path.join(root, "company-a"));
    await mkdir(path.join(root, "company-b"));
    await writeFile(path.join(root, "company-a/owned.md"), content);
    await writeFile(path.join(root, "company-b/sentinel.md"), "sentinel\n");
    await git("add", "-A");
    await git("commit", "-m", "seed");
    await run(root, env, git);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function tree(file: string): KnowledgeGitTree {
  return { files: [{ path: file, content }], contentHash: "fixture", pageCount: 1, excludedLifePages: 0 };
}

describe("knowledge export outbound rename isolation", () => {
  it("rejects an outbound staged rename without changing HEAD, index or bytes", async () => {
    await withRepository(async (root, env, git) => {
      await git("mv", "company-a/owned.md", "company-b/moved.md");
      const status = await git("status", "--porcelain", "-z");
      expect(status).toBe("R  company-b/moved.md\0company-a/owned.md\0");
      const beforeHead = await git("rev-parse", "HEAD");
      const beforeIndex = await git("diff", "--cached", "--binary");
      const beforeSentinel = await readFile(path.join(root, "company-b/sentinel.md"));
      const beforeMoved = await readFile(path.join(root, "company-b/moved.md"));
      await expect(commitKnowledgeTreeIfChanged(createSystemGitRunner(10_000), root, branch, tree("new.md"), env, "company-a"))
        .rejects.toThrow(/knowledge export:.*dirty checkout/i);
      expect(await git("rev-parse", "HEAD")).toBe(beforeHead);
      expect(await git("diff", "--cached", "--binary")).toBe(beforeIndex);
      expect(await readFile(path.join(root, "company-b/sentinel.md"))).toEqual(beforeSentinel);
      expect(await readFile(path.join(root, "company-b/moved.md"))).toEqual(beforeMoved);
      await expect(readFile(path.join(root, "company-a/owned.md"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(path.join(root, "company-a/new.md"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  }, 30_000);

  it("commits a staged rename entirely within the exporting company", async () => {
    await withRepository(async (root, env, git) => {
      await git("mv", "company-a/owned.md", "company-a/moved.md");
      expect(await git("status", "--porcelain", "-z")).toBe("R  company-a/moved.md\0company-a/owned.md\0");
      const beforeHead = (await git("rev-parse", "HEAD")).trim();
      const result = await commitKnowledgeTreeIfChanged(createSystemGitRunner(10_000), root, branch, tree("moved.md"), env, "company-a");
      expect(result.committed).toBe(true);
      expect(result.commit).not.toBe(beforeHead);
      expect(result.commit).toBe((await git("rev-parse", "HEAD")).trim());
      expect(await git("show", "HEAD:company-a/moved.md")).toBe(content);
      expect(await git("diff-tree", "--no-commit-id", "--name-status", "-r", "-M", "HEAD")).toContain("R100\tcompany-a/owned.md\tcompany-a/moved.md");
      expect(await git("status", "--porcelain")).toBe("");
      expect(await readFile(path.join(root, "company-b/sentinel.md"), "utf8")).toBe("sentinel\n");
    });
  }, 30_000);
});
