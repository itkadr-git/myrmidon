import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { commitKnowledgeTreeIfChanged, type GitExportRunner } from "./git-export-git.js";
import type { KnowledgeGitTree } from "./git-export.js";

const tree = (files: KnowledgeGitTree["files"]): KnowledgeGitTree => ({
  files, contentHash: "0123456789abcdef", pageCount: files.length, excludedLifePages: 0,
});

async function withScratch(run: (root: string, checkout: string) => Promise<void>) {
  const base = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.HOME;
  if (!base) throw new Error("No permitted scratch directory");
  const root = await mkdtemp(path.join(base, "knowledge-preflight-"));
  try {
    const checkout = path.join(root, "checkout");
    await mkdir(checkout);
    await run(root, checkout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function recordingRunner(status = "") {
  const calls: string[] = [];
  const runner: GitExportRunner = {
    async git(_cwd, args) {
      calls.push(args[0]!);
      return { stdout: args[0] === "status" ? status : args[0] === "rev-parse" ? `${"a".repeat(40)}\n` : "", stderr: "" };
    },
  };
  return { runner, calls };
}

describe("knowledge export preflight", () => {
  it.each(["relative", "absolute"])("rejects %s paths in either order without modifying bytes", async (kind) => {
    for (const invalidFirst of [false, true]) {
      await withScratch(async (root, checkout) => {
        const original = Buffer.from([0, 255, 10, 42]);
        const sentinel = Buffer.from([254, 0, 13, 10]);
        await writeFile(path.join(checkout, "valid.md"), original);
        await writeFile(path.join(root, "outside.md"), sentinel);
        const invalid = { path: kind === "relative" ? "../outside.md" : path.join(root, "outside.md"), content: "bad" };
        const valid = { path: "valid.md", content: "replacement" };
        const { runner, calls } = recordingRunner();
        await expect(commitKnowledgeTreeIfChanged(runner, checkout, "knowledge-export", tree(invalidFirst ? [invalid, valid] : [valid, invalid])))
          .rejects.toThrow(/refusing to write a path outside/);
        expect(await readdir(checkout)).toEqual(["valid.md"]);
        expect(await readFile(path.join(checkout, "valid.md"))).toEqual(original);
        expect(await readFile(path.join(root, "outside.md"))).toEqual(sentinel);
        expect(calls).toEqual([]);
      });
    }
  });

  it.each([false, true])("preserves valid export bytes and clean/dirty contract (dirty=%s)", async (dirty) => {
    await withScratch(async (_root, checkout) => {
      const { runner, calls } = recordingRunner(dirty ? " M nested/valid.md\n" : "");
      const content = "valid\n\u0000 unicode: \u00e9\n";
      const result = await commitKnowledgeTreeIfChanged(runner, checkout, "knowledge-export", tree([{ path: "nested/valid.md", content }]));
      expect(await readFile(path.join(checkout, "nested/valid.md"))).toEqual(Buffer.from(content));
      expect(result).toEqual(dirty ? { committed: true, commit: "a".repeat(40) } : { committed: false, commit: null });
      expect(calls).toEqual(dirty ? ["ls-files", "add", "status", "commit", "rev-parse"] : ["ls-files", "add", "status"]);
    });
  });
});
