import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { commitKnowledgeTreeIfChanged, createSystemGitRunner } from "./git-export-git.js";
import type { KnowledgeGitTree } from "./git-export.js";

const exec = promisify(execFile);
const tree: KnowledgeGitTree = { files: [{ path: "page.md", content: "published A\n" }], contentHash: "fixture", pageCount: 1, excludedLifePages: 0 };

async function withRepository(run: (root: string, env: NodeJS.ProcessEnv, git: (...args: string[]) => Promise<string>) => Promise<void>) {
  const root = await mkdtemp(path.join(process.env.MYRMIDON_RUN_SCRATCH_DIR || process.env.MYRMIDON_SCRATCH_DIR || homedir(), "knowledge-inbound-"));
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "empty-config"),
    GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "0", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test",
  };
  const git = async (...args: string[]) => (await exec("git", args, { cwd: root, env, timeout: 10_000 })).stdout;
  try {
    await git("init", "-b", "knowledge-export");
    await mkdir(path.join(root, "company-b"));
    await writeFile(path.join(root, "company-b", "seed.md"), "seed\n");
    await git("add", "--all");
    await git("commit", "-m", "seed");
    await run(root, env, git);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("knowledge export inbound rename isolation", () => {
  it.each(["private file.md", "private\nfile.md"])("rejects staged inbound rename with name %j without changing bytes or index", async (name) => {
    await withRepository(async (root, env, git) => {
      const source = `company-b/${name}`;
      const destination = `company-a/imported ${name}`;
      const bytes = Buffer.from([0, 255, 10, 65]);
      await writeFile(path.join(root, source), bytes);
      await git("add", "--", source);
      await git("commit", "-m", "track private file");
      await mkdir(path.join(root, "company-a"));
      await git("mv", "--", source, destination);
      const status = await git("status", "--porcelain", "-z", "--untracked-files=all");
      expect(status.split("\0")).toEqual([`R  ${destination}`, source, ""]);
      const head = await git("rev-parse", "HEAD");
      const diff = await git("diff", "--cached", "--binary", "--no-ext-diff");
      await expect(commitKnowledgeTreeIfChanged(createSystemGitRunner(10_000), root, "knowledge-export", tree, env, "company-a"))
        .rejects.toThrow(/knowledge export:.*dirty checkout/i);
      expect(await git("rev-parse", "HEAD")).toBe(head);
      expect(await git("status", "--porcelain", "-z", "--untracked-files=all")).toBe(status);
      expect(await git("diff", "--cached", "--binary", "--no-ext-diff")).toBe(diff);
      expect(await readFile(path.join(root, destination))).toEqual(bytes);
      await expect(readFile(path.join(root, source))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(path.join(root, "company-a", "page.md"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  }, 30_000);

  it("publishes a clean company A tree and preserves company B", async () => {
    await withRepository(async (root, env, git) => {
      const before = await git("rev-parse", "HEAD");
      const result = await commitKnowledgeTreeIfChanged(createSystemGitRunner(10_000), root, "knowledge-export", tree, env, "company-a");
      expect(result.committed).toBe(true);
      expect(result.commit).toBe((await git("rev-parse", "HEAD")).trim());
      expect(result.commit).not.toBe(before.trim());
      expect(await git("show", "HEAD:company-a/page.md")).toBe("published A\n");
      expect(await git("show", "HEAD:company-b/seed.md")).toBe("seed\n");
      expect(await git("status", "--porcelain", "-z")).toBe("");
    });
  }, 30_000);
});
