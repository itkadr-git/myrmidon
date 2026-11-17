import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { commitKnowledgeTreeIfChanged, type GitExportRunner } from "./git-export-git.js";
import type { KnowledgeGitTree } from "./git-export.js";

const writes = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, writeFile: (...args: Parameters<typeof fs.writeFile>) => {
    writes(args[0]);
    return fs.writeFile(...args);
  } };
});

const tree = (files: KnowledgeGitTree["files"]): KnowledgeGitTree => ({
  files, contentHash: "0123456789abcdef", pageCount: files.length, excludedLifePages: 0,
});

async function withScratch(run: (root: string, checkout: string) => Promise<void>) {
  const base = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.HOME;
  if (!base) throw new Error("No permitted scratch directory");
  const root = await mkdtemp(path.join(base, "knowledge-nul-preflight-"));
  try {
    const checkout = path.join(root, "checkout");
    await mkdir(checkout);
    await run(root, checkout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function recordingRunner() {
  const calls: string[] = [];
  const runner: GitExportRunner = {
    async git(_cwd, args) {
      calls.push(args[0]!);
      return { stdout: args[0] === "status" ? (args.includes("-z") ? "" : " M valid.md\n") : args[0] === "rev-parse" ? `${"a".repeat(40)}\n` : "", stderr: "" };
    },
  };
  return { runner, calls };
}

describe("knowledge export NUL path preflight", () => {
  it.each([undefined, "company"]) ("rejects NUL before any write or git call (prefix=%s)", async (prefix) => {
    for (const invalidFirst of [false, true]) {
      await withScratch(async (root, checkout) => {
        const destination = path.join(checkout, prefix ?? "");
        await mkdir(destination, { recursive: true });
        const original = Buffer.from([0, 255, 10, 42]);
        const sentinel = Buffer.from([254, 0, 13, 10]);
        await writeFile(path.join(destination, "valid.md"), original);
        await writeFile(path.join(root, "sentinel"), sentinel);
        const valid = { path: "valid.md", content: "replacement" };
        const invalid = { path: "bad\u0000.md", content: "bad" };
        const { runner, calls } = recordingRunner();
        writes.mockClear();
        await expect(commitKnowledgeTreeIfChanged(runner, checkout, "knowledge-export", tree(invalidFirst ? [invalid, valid] : [valid, invalid]), undefined, prefix)).rejects.toThrow();
        expect(writes).not.toHaveBeenCalled();
        expect(calls).toEqual([]);
        expect(await readFile(path.join(destination, "valid.md"))).toEqual(original);
        expect(await readFile(path.join(root, "sentinel"))).toEqual(sentinel);
      });
    }
  });

  it.each([undefined, "company"])("writes a valid Unicode path and commits (prefix=%s)", async (prefix) => {
    await withScratch(async (_root, checkout) => {
      const { runner, calls } = recordingRunner();
      const content = "Unicode content\n";
      const result = await commitKnowledgeTreeIfChanged(runner, checkout, "knowledge-export", tree([{ path: "caf\u00e9/\u6587.md", content }]), undefined, prefix);
      expect(await readFile(path.join(checkout, prefix ?? "", "caf\u00e9/\u6587.md"))).toEqual(Buffer.from(content));
      expect(result).toEqual({ committed: true, commit: "a".repeat(40) });
      expect(calls).toEqual([...(prefix ? ["status"] : []), "ls-files", "add", "status", "commit", "rev-parse"]);
    });
  });
});
