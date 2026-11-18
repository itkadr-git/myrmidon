import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { commitKnowledgeTreeIfChanged, type GitExportRunner } from "./git-export-git.js";
import type { KnowledgeGitTree } from "./git-export.js";

const makeTree = (files: KnowledgeGitTree["files"]): KnowledgeGitTree => ({
  files, contentHash: "0123456789abcdef", pageCount: files.length, excludedLifePages: 0,
});

describe("knowledge export path shape preflight", () => {
  it.each(["parent-first", "child-first", "existing-parent-file", "existing-target-directory"])(
    "rejects %s before any writes or git calls", async (scenario) => {
      const base = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.HOME;
      if (!base) throw new Error("No permitted scratch directory");
      const root = await mkdtemp(path.join(base, "knowledge-shape-"));
      try {
        const original = Buffer.from([0, 255, 10, 42]);
        await writeFile(path.join(root, "valid.md"), original);
        const parent = { path: "a", content: "parent" };
        const child = { path: "a/b.md", content: "child" };
        let conflicts = scenario === "parent-first" ? [parent, child] : [child, parent];
        if (scenario === "existing-parent-file") {
          await writeFile(path.join(root, "nested"), original);
          conflicts = [{ path: "nested/new.md", content: "child" }];
        } else if (scenario === "existing-target-directory") {
          await mkdir(path.join(root, "target.md"));
          conflicts = [{ path: "target.md", content: "child" }];
        }
        const before = (await readdir(root)).sort();
        const calls: string[][] = [];
        const runner: GitExportRunner = { async git(_cwd, args) { calls.push(args); return { stdout: "", stderr: "" }; } };
        const promise = commitKnowledgeTreeIfChanged(runner, root, "knowledge-export", makeTree([
          { path: "valid.md", content: "replacement" }, ...conflicts,
        ]));
        await expect(promise).rejects.toThrow();
        expect(await readFile(path.join(root, "valid.md"))).toEqual(original);
        expect((await readdir(root)).sort()).toEqual(before);
        if (scenario === "existing-parent-file") expect(await readFile(path.join(root, "nested"))).toEqual(original);
        if (scenario === "existing-target-directory") expect(await readdir(path.join(root, "target.md"))).toEqual([]);
        expect(calls).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
