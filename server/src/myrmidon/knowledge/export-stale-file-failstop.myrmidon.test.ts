import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { commitKnowledgeTreeIfChanged, type GitExportRunner } from "./git-export-git.js";
import type { KnowledgeGitTree } from "./git-export.js";

const tree: KnowledgeGitTree = { files: [], contentHash: "0123456789abcdef", pageCount: 0, excludedLifePages: 0 };

function recordingRunner() {
  const calls: string[] = [];
  const runner: GitExportRunner = {
    async git(_cwd, args) {
      calls.push(args[0]!);
      if (args[0] === "ls-files") return { stdout: "company/stale\0", stderr: "" };
      if (args[0] === "status") return { stdout: args.includes("-z") ? "" : " D company/stale\n", stderr: "" };
      if (args[0] === "rev-parse") return { stdout: `${"a".repeat(40)}\n`, stderr: "" };
      return { stdout: "", stderr: "" };
    },
  };
  return { runner, calls };
}

async function withScratch(run: (checkout: string) => Promise<void>) {
  const base = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.HOME;
  if (!base) throw new Error("No permitted scratch directory");
  const root = await mkdtemp(path.join(base, "knowledge-stale-"));
  try {
    await mkdir(path.join(root, "company"));
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("knowledge export stale file fail-stop", () => {
  it("rejects an unlink error before staging while preserving the sentinel", async () => {
    await withScratch(async (checkout) => {
      await mkdir(path.join(checkout, "company/stale"));
      const sentinel = path.join(checkout, "company/stale/sentinel");
      await writeFile(sentinel, "unchanged");
      const { runner, calls } = recordingRunner();
      await expect(commitKnowledgeTreeIfChanged(runner, checkout, "knowledge-export", tree, undefined, "company"))
        .rejects.toMatchObject({ code: "EISDIR" });
      expect(calls).toEqual(["status", "ls-files"]);
      expect(await readFile(sentinel, "utf8")).toBe("unchanged");
    });
  });

  it("deletes a stale file and stages and commits the deletion", async () => {
    await withScratch(async (checkout) => {
      const stale = path.join(checkout, "company/stale");
      await writeFile(stale, "old");
      const { runner, calls } = recordingRunner();
      await expect(commitKnowledgeTreeIfChanged(runner, checkout, "knowledge-export", tree, undefined, "company"))
        .resolves.toEqual({ committed: true, commit: "a".repeat(40) });
      await expect(readFile(stale)).rejects.toMatchObject({ code: "ENOENT" });
      expect(calls).toEqual(["status", "ls-files", "add", "status", "commit", "rev-parse"]);
    });
  });

  it("accepts an already absent stale file", async () => {
    await withScratch(async (checkout) => {
      const { runner, calls } = recordingRunner();
      await expect(commitKnowledgeTreeIfChanged(runner, checkout, "knowledge-export", tree, undefined, "company"))
        .resolves.toEqual({ committed: true, commit: "a".repeat(40) });
      expect(calls).toEqual(["status", "ls-files", "add", "status", "commit", "rev-parse"]);
    });
  });
});
