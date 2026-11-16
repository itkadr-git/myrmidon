import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { commitKnowledgeTreeIfChanged, createSystemGitRunner } from "./git-export-git.js";
import type { KnowledgeGitTree } from "./git-export.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

describe("tracked knowledge export paths", () => {
  it("deletes complete whitespace-bearing paths and keeps exact bytes on a quiet repeat", async () => {
    const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? process.env.TMPDIR ?? os.homedir();
    const dir = await mkdtemp(path.join(scratch, "knowledge-nul-"));
    try {
      await git(dir, "init", "-b", "knowledge-export");
      await git(dir, "config", "user.name", "Test");
      await git(dir, "config", "user.email", "test@example.com");
      const stale = ["stale space.md", "stale\ttab.md", "stale\nline.md"];
      const kept = "keep space\ttab\nline.md";
      const content = "retained bytes: \u00e9\nsecond line\n";
      for (const name of [...stale, kept]) await writeFile(path.join(dir, name), `old ${name}\n`);
      await git(dir, "add", "-A");
      await git(dir, "commit", "-m", "seed tracked files");
      const initialHead = (await git(dir, "rev-parse", "HEAD")).trim();
      const tree: KnowledgeGitTree = {
        files: [{ path: kept, content }],
        contentHash: "0123456789abcdef",
        pageCount: 1,
        excludedLifePages: 0,
      };
      const runner = createSystemGitRunner();
      const result = await commitKnowledgeTreeIfChanged(runner, dir, "knowledge-export", tree);
      expect(result.committed).toBe(true);
      expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(result.commit).not.toBe(initialHead);
      expect((await git(dir, "ls-tree", "-r", "--name-only", "-z", "HEAD")).split("\0").filter(Boolean)).toEqual([kept]);
      expect(await git(dir, "show", `HEAD:${kept}`)).toBe(content);
      expect(await readFile(path.join(dir, kept))).toEqual(Buffer.from(content, "utf8"));
      expect((await git(dir, "ls-files", "--others", "--exclude-standard", "-z"))).toBe("");
      expect((await git(dir, "status", "--porcelain", "-z"))).toBe("");
      const repeat = await commitKnowledgeTreeIfChanged(runner, dir, "knowledge-export", tree);
      expect(repeat).toEqual({ committed: false, commit: null });
      expect((await git(dir, "rev-parse", "HEAD")).trim()).toBe(result.commit);
      expect((await git(dir, "rev-list", "--count", "HEAD")).trim()).toBe("2");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
