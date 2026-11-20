import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { commitKnowledgeTreeIfChanged, type GitExportRunner } from "./git-export-git.js";
import type { KnowledgeGitTree } from "./git-export.js";

const tree = (files: KnowledgeGitTree["files"]): KnowledgeGitTree => ({
  files, contentHash: "fixture-hash", pageCount: files.length, excludedLifePages: 0,
});

async function withCheckout(run: (checkout: string) => Promise<void>) {
  const base = process.env.MYRMIDON_RUN_SCRATCH_DIR || process.env.MYRMIDON_SCRATCH_DIR || homedir();
  const root = await mkdtemp(path.join(base, "myrmidon-git-metadata-"));
  try {
    const checkout = path.join(root, "checkout");
    await mkdir(checkout);
    execFileSync("git", ["init", "-b", "knowledge-export"], {
      cwd: checkout, timeout: 10_000,
      env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: path.join(root, "no-global-config"), GIT_CONFIG_NOSYSTEM: "1" },
    });
    await run(checkout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function recordingRunner() {
  const calls: string[][] = [];
  const runner: GitExportRunner = {
    async git(_cwd, args) {
      calls.push([...args]);
      return { stdout: "", stderr: "" };
    },
  };
  return { runner, calls };
}

describe("knowledge export git metadata preflight", () => {
  it.each([
    { target: ".git/config", position: 1 },
    { target: ".git/HEAD", position: 2 },
  ])("rejects $target at position $position before any write or git operation", async ({ target, position }) => {
    await withCheckout(async (checkout) => {
      const config = await readFile(path.join(checkout, ".git/config"));
      const head = await readFile(path.join(checkout, ".git/HEAD"));
      const sentinel = Buffer.from([0, 255, 13, 10]);
      await writeFile(path.join(checkout, "valid.md"), sentinel);
      const files = [{ path: "valid.md", content: "replacement" }, { path: "other.md", content: "other" }];
      files.splice(position, 0, { path: target, content: "corrupt metadata" });
      const { runner, calls } = recordingRunner();
      await expect(commitKnowledgeTreeIfChanged(runner, checkout, "knowledge-export", tree(files)))
        .rejects.toThrow(/refusing to write.*git/i);
      expect(await readFile(path.join(checkout, ".git/config"))).toEqual(config);
      expect(await readFile(path.join(checkout, ".git/HEAD"))).toEqual(head);
      expect(await readFile(path.join(checkout, "valid.md"))).toEqual(sentinel);
      await expect(readFile(path.join(checkout, "other.md"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(calls).toEqual([]);
    });
  });

  it("writes an ordinary nested page and returns the clean result", async () => {
    await withCheckout(async (checkout) => {
      const { runner, calls } = recordingRunner();
      const content = "nested page\n";
      const result = await commitKnowledgeTreeIfChanged(runner, checkout, "knowledge-export", tree([{ path: "nested/page.md", content }]));
      expect(await readFile(path.join(checkout, "nested/page.md"))).toEqual(Buffer.from(content));
      expect(result).toEqual({ committed: false, commit: null });
      expect(calls).toEqual([["ls-files", "-z"], ["add", "-A"], ["status", "--porcelain"]]);
    });
  });
});
