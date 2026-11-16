import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { commitKnowledgeTreeIfChanged, type GitExportRunner } from "./git-export-git.js";
import type { KnowledgeGitTree } from "./git-export.js";

const tree: KnowledgeGitTree = {
  files: [{ path: "page.md", content: "exported\n" }],
  contentHash: "root-symlink-content-hash",
  pageCount: 1,
  excludedLifePages: 0,
};

async function withScratch(run: (root: string) => Promise<void>) {
  const base = process.env.MYRMIDON_RUN_SCRATCH_DIR
    || process.env.MYRMIDON_SCRATCH_DIR
    || process.env.PAPERCLIP_RUN_SCRATCH_DIR
    || process.env.PAPERCLIP_SCRATCH_DIR
    || homedir();
  const root = await mkdtemp(path.join(base, "myrmidon-export-root-symlink-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function recordingRunner() {
  const calls: string[][] = [];
  const runner: GitExportRunner = {
    async git(_cwd, args) {
      calls.push([...args]);
      return { stdout: args[0] === "status" ? " M page.md\n" : args[0] === "rev-parse" ? "a".repeat(40) : "", stderr: "" };
    },
  };
  return { runner, calls };
}

describe("knowledge export root symlink preflight", () => {
  it("rejects a symlink checkout root before writing to its target or running git", async () => {
    await withScratch(async (root) => {
      const outside = path.join(root, "outside");
      const workDir = path.join(root, "checkout");
      const sentinel = path.join(outside, "sentinel.md");
      await mkdir(outside);
      await writeFile(sentinel, "unchanged\n");
      await symlink(outside, workDir);
      const { runner, calls } = recordingRunner();

      await expect(commitKnowledgeTreeIfChanged(runner, workDir, "export", tree))
        .rejects.toThrow(/symlink/);
      expect(await readFile(sentinel, "utf8")).toBe("unchanged\n");
      await expect(readFile(path.join(outside, "page.md"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(calls).toEqual([]);
    });
  });

  it("writes and commits through an ordinary checkout root", async () => {
    await withScratch(async (root) => {
      const workDir = path.join(root, "checkout");
      await mkdir(workDir);
      const { runner, calls } = recordingRunner();

      await expect(commitKnowledgeTreeIfChanged(runner, workDir, "export", tree)).resolves.toEqual({
        committed: true,
        commit: "a".repeat(40),
      });
      expect(await readFile(path.join(workDir, "page.md"), "utf8")).toBe("exported\n");
      expect(calls.map(([command]) => command)).toEqual([
        "ls-files",
        "add",
        "status",
        "commit",
        "rev-parse",
      ]);
    });
  });
});
