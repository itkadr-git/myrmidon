import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { commitKnowledgeTreeIfChanged, type GitExportRunner } from "./git-export-git.js";
import type { KnowledgeGitTree } from "./git-export.js";

const tree = (files: KnowledgeGitTree["files"]): KnowledgeGitTree => ({
  files, contentHash: "0123456789abcdef", pageCount: files.length, excludedLifePages: 0,
});

async function withCheckout(run: (checkout: string) => Promise<void>) {
  const base = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.HOME;
  if (!base) throw new Error("No permitted scratch directory");
  const root = await mkdtemp(path.join(base, "knowledge-duplicate-"));
  try {
    const checkout = path.join(root, "checkout");
    await mkdir(checkout);
    await run(checkout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function recordingRunner() {
  const calls: string[] = [];
  const runner: GitExportRunner = {
    async git(_cwd, args) {
      calls.push(args[0]!);
      return { stdout: args[0] === "status" ? " M files\n" : args[0] === "rev-parse" ? `${"a".repeat(40)}\n` : "", stderr: "" };
    },
  };
  return { runner, calls };
}

describe("direct knowledge export duplicate preflight", () => {
  it.each([undefined, "company-1"])("rejects duplicate resolved paths without writes or git (prefix=%s)", async (prefix) => {
    for (const reverse of [false, true]) {
      await withCheckout(async (checkout) => {
        const target = prefix ? path.join(checkout, prefix) : checkout;
        await mkdir(target, { recursive: true });
        const original = Buffer.from([0, 255, 10, 42]);
        const sentinel = Buffer.from([254, 0, 13, 10]);
        await writeFile(path.join(target, "duplicate.md"), original);
        await writeFile(path.join(target, "sentinel.md"), sentinel);
        const duplicates = [{ path: "duplicate.md", content: "first" }, { path: "./duplicate.md", content: "second" }];
        const files = [{ path: "before.md", content: "before" }, ...(reverse ? duplicates.reverse() : duplicates), { path: "after.md", content: "after" }];
        const { runner, calls } = recordingRunner();
        await expect(commitKnowledgeTreeIfChanged(runner, checkout, "knowledge-export", tree(files), undefined, prefix))
          .rejects.toThrow(/duplicate/i);
        expect(await readdir(target)).toEqual(["duplicate.md", "sentinel.md"]);
        expect(await readFile(path.join(target, "duplicate.md"))).toEqual(original);
        expect(await readFile(path.join(target, "sentinel.md"))).toEqual(sentinel);
        expect(calls).toEqual([]);
      });
    }
  });

  it("writes both unique files and returns the commit result", async () => {
    await withCheckout(async (checkout) => {
      const { runner, calls } = recordingRunner();
      const result = await commitKnowledgeTreeIfChanged(runner, checkout, "knowledge-export", tree([
        { path: "first.md", content: "first\n" }, { path: "nested/second.md", content: "second\n" },
      ]));
      expect(await readFile(path.join(checkout, "first.md"))).toEqual(Buffer.from("first\n"));
      expect(await readFile(path.join(checkout, "nested/second.md"))).toEqual(Buffer.from("second\n"));
      expect(result).toEqual({ committed: true, commit: "a".repeat(40) });
      expect(calls).toEqual(["ls-files", "add", "status", "commit", "rev-parse"]);
    });
  });
});
