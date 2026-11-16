import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { commitKnowledgeTreeIfChanged, type GitExportRunner } from "./git-export-git.js";
import type { KnowledgeGitTree } from "./git-export.js";

const tree: KnowledgeGitTree = { files: [], contentHash: "fixture-hash", pageCount: 0, excludedLifePages: 0 };
const tracked = "company-a/old/stale.md";

async function withScratch(run: (root: string, checkout: string) => Promise<void>) {
  const base = process.env.MYRMIDON_RUN_SCRATCH_DIR || process.env.MYRMIDON_SCRATCH_DIR || homedir();
  const root = await mkdtemp(path.join(base, "myrmidon-stale-"));
  try {
    const checkout = path.join(root, "checkout");
    await mkdir(path.join(checkout, "company-a"), { recursive: true });
    await run(root, checkout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function recordingRunner() {
  const calls: string[][] = [];
  const runner: GitExportRunner = {
    async git(_cwd, args) {
      calls.push([...args]);
      return { stdout: args[0] === "ls-files" ? `${tracked}\0` : args[0] === "status" && !args.includes("-z") ? "D  company-a/old/stale.md\n" : args[0] === "rev-parse" ? `${"a".repeat(40)}\n` : "", stderr: "" };
    },
  };
  return { runner, calls };
}

describe("knowledge export stale ancestor containment", () => {
  it("rejects a stale path through a symlink before unlink or staging", async () => {
    await withScratch(async (root, checkout) => {
      const outside = path.join(root, "outside");
      await mkdir(outside);
      const sentinel = path.join(outside, "stale.md");
      const bytes = Buffer.from([0, 1, 2, 255, 10]);
      await writeFile(sentinel, bytes);
      await symlink(outside, path.join(checkout, "company-a", "old"));
      const { runner, calls } = recordingRunner();
      const outcome = await commitKnowledgeTreeIfChanged(runner, checkout, "export", tree, undefined, "company-a")
        .then((result) => ({ result, error: null }), (error: unknown) => ({ result: null, error }));
      expect(await readFile(sentinel)).toEqual(bytes);
      expect(outcome.error).toBeInstanceOf(Error);
      expect(String(outcome.error)).toMatch(/symlink/);
      expect(outcome.result).toBeNull();
      expect(calls).toEqual([["status", "--porcelain", "-z", "--untracked-files=all"], ["ls-files", "-z"]]);
    });
  });

  it("deletes a regular tracked stale file and stages the deletion", async () => {
    await withScratch(async (_root, checkout) => {
      const stale = path.join(checkout, tracked);
      await mkdir(path.dirname(stale));
      await writeFile(stale, "old content\n");
      const { runner, calls } = recordingRunner();
      const result = await commitKnowledgeTreeIfChanged(runner, checkout, "export", tree, undefined, "company-a");
      await expect(readFile(stale)).rejects.toMatchObject({ code: "ENOENT" });
      expect(result).toEqual({ committed: true, commit: "a".repeat(40) });
      expect(calls.map((args) => args[0])).toEqual(["status", "ls-files", "add", "status", "commit", "rev-parse"]);
      expect(calls[0]).toEqual(["status", "--porcelain", "-z", "--untracked-files=all"]);
      expect(calls[2]).toEqual(["add", "-A"]);
    });
  });
});
