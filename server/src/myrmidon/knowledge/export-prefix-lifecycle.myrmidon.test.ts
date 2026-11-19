import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { commitKnowledgeTreeIfChanged, type GitExportRunner } from "./git-export-git.js";
import type { KnowledgeGitTree } from "./git-export.js";

const tree = (files: KnowledgeGitTree["files"]): KnowledgeGitTree => ({
  files,
  contentHash: "0123456789abcdef",
  pageCount: files.length,
  excludedLifePages: 0,
});

function recordingRunner(tracked: string[] = [], status = "") {
  const calls: string[][] = [];
  const runner: GitExportRunner = {
    async git(_cwd, args) {
      calls.push(args);
      if (args[0] === "ls-files") return { stdout: `${tracked.join("\0")}\0`, stderr: "" };
      if (args[0] === "status") return { stdout: args.includes("-z") ? "" : status, stderr: "" };
      if (args[0] === "rev-parse") return { stdout: `${"a".repeat(40)}\n`, stderr: "" };
      return { stdout: "", stderr: "" };
    },
  };
  return { runner, calls };
}

async function withScratch(run: (root: string, checkout: string) => Promise<void>) {
  const base = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.HOME;
  if (!base) throw new Error("No permitted scratch directory");
  const root = await mkdtemp(path.join(base, "knowledge-prefix-"));
  try {
    const checkout = path.join(root, "checkout");
    await mkdir(checkout);
    await run(root, checkout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("knowledge export prefix lifecycle", () => {
  it("deletes only tracked files in the exact company prefix and commits a dirty tree", async () => {
    await withScratch(async (_root, checkout) => {
      const initial = {
        "company-a/old.md": "old a\n",
        "company-a/keep.md": "previous\n",
        "company-ab/old.md": "adjacent \u0000 bytes\n",
        "company-b/old.md": "other company\n",
      };
      for (const [name, content] of Object.entries(initial)) {
        const target = path.join(checkout, name);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content);
      }
      const { runner, calls } = recordingRunner(Object.keys(initial), " D company-a/old.md\n M company-a/keep.md\n");
      const result = await commitKnowledgeTreeIfChanged(runner, checkout, "knowledge-export", tree([
        { path: "keep.md", content: "updated\n" },
        { path: "nested/deep/new.md", content: "nested\n" },
      ]), undefined, "company-a");
      expect(result).toEqual({ committed: true, commit: "a".repeat(40) });
      await expect(readFile(path.join(checkout, "company-a/old.md"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(path.join(checkout, "company-a/keep.md"), "utf8")).toBe("updated\n");
      expect(await readFile(path.join(checkout, "company-a/nested/deep/new.md"), "utf8")).toBe("nested\n");
      expect(await readFile(path.join(checkout, "company-ab/old.md"))).toEqual(Buffer.from(initial["company-ab/old.md"]));
      expect(await readFile(path.join(checkout, "company-b/old.md"))).toEqual(Buffer.from(initial["company-b/old.md"]));
      expect(calls[0]).toEqual(["status", "--porcelain", "-z", "--untracked-files=all"]);
      expect(calls[1]).toEqual(["ls-files", "-z"]);
      expect(calls.filter((args) => args[0] === "commit")).toHaveLength(1);
      expect(calls.map((args) => args[0])).toEqual(["status", "ls-files", "add", "status", "commit", "rev-parse"]);
    });
  });

  it("returns clean without a commit for a valid prefix", async () => {
    await withScratch(async (_root, checkout) => {
      const { runner, calls } = recordingRunner(["company-a/keep.md"], "  \n");
      const result = await commitKnowledgeTreeIfChanged(runner, checkout, "knowledge-export", tree([
        { path: "keep.md", content: "unchanged\n" },
      ]), undefined, "company-a");
      expect(result).toEqual({ committed: false, commit: null });
      expect(await readFile(path.join(checkout, "company-a/keep.md"), "utf8")).toBe("unchanged\n");
      expect(calls.map((args) => args[0])).toEqual(["status", "ls-files", "add", "status"]);
      expect(calls.filter((args) => args[0] === "commit")).toHaveLength(0);
    });
  });

  it.each(["../a", "a/b", ".", ".."])("rejects unsafe prefix %s before writes or git", async (prefix) => {
    await withScratch(async (_root, checkout) => {
      const { runner, calls } = recordingRunner();
      await expect(commitKnowledgeTreeIfChanged(runner, checkout, "knowledge-export", tree([
        { path: "keep.md", content: "not written" },
      ]), undefined, prefix)).rejects.toThrow(/unsafe path prefix/);
      expect(calls).toEqual([]);
      expect(await readdir(checkout)).toEqual([]);
    });
  });

  it.each(["relative", "absolute"])("rejects a %s escape file path", async (kind) => {
    await withScratch(async (root, checkout) => {
      const { runner, calls } = recordingRunner();
      const escaped = path.join(root, "outside.md");
      const filePath = kind === "relative" ? "../outside.md" : escaped;
      await expect(commitKnowledgeTreeIfChanged(runner, checkout, "knowledge-export", tree([
        { path: filePath, content: "not written" },
      ]), undefined, "company-a")).rejects.toThrow(/refusing to write a path outside/);
      expect(calls).toEqual([]);
      expect(await readdir(checkout)).toEqual([]);
      await expect(readFile(escaped)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(path.join(checkout, "outside.md"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
