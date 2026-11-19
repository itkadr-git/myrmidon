import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { commitKnowledgeTreeIfChanged, type GitExportRunner } from "./git-export-git.js";
import type { KnowledgeGitTree } from "./git-export.js";

const tree = (files: KnowledgeGitTree["files"]): KnowledgeGitTree => ({
  files, contentHash: "0123456789abcdef", pageCount: files.length, excludedLifePages: 0,
});

function recordingRunner(status = "") {
  const calls: string[][] = [];
  const runner: GitExportRunner = {
    async git(_cwd, args) {
      calls.push(args);
      return { stdout: args[0] === "status" ? status : args[0] === "rev-parse" ? "a".repeat(40) : "", stderr: "" };
    },
  };
  return { runner, calls };
}

async function withScratch(run: (root: string, checkout: string) => Promise<void>) {
  const base = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.HOME;
  if (!base) throw new Error("No permitted scratch directory");
  const root = await mkdtemp(path.join(base, "knowledge-symlink-"));
  try {
    const checkout = path.join(root, "checkout");
    await mkdir(checkout);
    await run(root, checkout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("knowledge export symlink containment", () => {
  it.each(["leaf", "ancestor", "prefix", "internal"])("rejects %s symlinks before any write or staging", async (kind) => {
    await withScratch(async (root, checkout) => {
      const outside = path.join(root, "outside");
      const company = path.join(checkout, "company-a");
      await mkdir(outside);
      const sentinel = path.join(outside, "sentinel.md");
      const bytes = Buffer.from([0, 1, 2, 255, 10]);
      await writeFile(sentinel, bytes);
      let target = "item.md";
      if (kind === "prefix") {
        await symlink(outside, company);
      } else {
        await mkdir(company);
        if (kind === "leaf") await symlink(sentinel, path.join(company, "item.md"));
        if (kind === "ancestor") {
          await symlink(outside, path.join(company, "nested"));
          target = "nested/new.md";
        }
        if (kind === "internal") {
          await mkdir(path.join(checkout, "inside"));
          await symlink(path.join(checkout, "inside"), path.join(company, "nested"));
          target = "nested/new.md";
        }
      }
      const { runner, calls } = recordingRunner("dirty");
      await expect(commitKnowledgeTreeIfChanged(runner, checkout, "export", tree([
        { path: "early.md", content: "must not exist" },
        { path: target, content: "must not be written" },
      ]), undefined, "company-a")).rejects.toThrow();
      expect(await readFile(sentinel)).toEqual(bytes);
      await expect(readFile(path.join(outside, "new.md"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(path.join(outside, "item.md"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(path.join(company, "early.md"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(calls.filter(([command]) => ["add", "commit", "push"].includes(command!))).toEqual([]);
    });
  });

  it.each([false, true])("preserves the normal clean/dirty contract (dirty=%s)", async (dirty) => {
    await withScratch(async (_root, checkout) => {
      const { runner, calls } = recordingRunner(dirty ? " M company-a/item.md" : "");
      const result = await commitKnowledgeTreeIfChanged(runner, checkout, "export", tree([
        { path: "nested/item.md", content: "normal" },
      ]), undefined, "company-a");
      expect(await readFile(path.join(checkout, "company-a/nested/item.md"), "utf8")).toBe("normal");
      expect(result).toEqual({ committed: dirty, commit: dirty ? "a".repeat(40) : null });
      expect(calls.some(([command]) => command === "commit")).toBe(dirty);
    });
  });
});
