import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publishKnowledgeExport, type GitExportRunner } from "./git-export-git.js";
import type { KnowledgeGitTree } from "./git-export.js";

const fault = vi.hoisted(() => ({ path: "", error: undefined as NodeJS.ErrnoException | undefined, attempts: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (String(args[0]) === fault.path && fault.error) {
        fault.attempts++;
        throw fault.error;
      }
      return actual.writeFile(...args);
    },
  };
});

afterEach(() => { fault.path = ""; fault.error = undefined; fault.attempts = 0; });

const content = "Page: \u00e9\n\u96ea\n";
const tree: KnowledgeGitTree = {
  files: [{ path: "pages/page.md", content }],
  contentHash: "0123456789abcdef", pageCount: 1, excludedLifePages: 0,
};

async function withCheckout(run: (checkout: string, calls: string[][], runner: GitExportRunner) => Promise<void>) {
  const base = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.HOME;
  if (!base) throw new Error("No permitted scratch directory");
  const root = await mkdtemp(path.join(base, "knowledge-write-failstop-"));
  try {
    const checkout = path.join(root, "checkout");
    await mkdir(path.join(checkout, ".git"), { recursive: true });
    await writeFile(path.join(checkout, ".git", "HEAD"), "fixture");
    await writeFile(path.join(checkout, "sentinel.md"), Buffer.from([0, 255, 10]));
    const calls: string[][] = [];
    const runner: GitExportRunner = {
      async git(_cwd, args) {
        calls.push(args);
        const stdout = args[0] === "ls-files" ? "sentinel.md\0" : args[0] === "status" ? " M pages/page.md\n" : args[0] === "rev-parse" ? `${"a".repeat(40)}\n` : "";
        return { stdout, stderr: "" };
      },
    };
    await run(checkout, calls, runner);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const input = (workDir: string, runner: GitExportRunner) => ({
  workDir, runner, repoUrl: "https://example.invalid/repo.git", branch: "knowledge-export", tree,
});

describe("knowledge export page write fail-stop", () => {
  it.each(["EIO", "ENOSPC"])("rejects %s during page write without publishing or deleting the sentinel", async (code) => {
    await withCheckout(async (checkout, calls, runner) => {
      fault.path = path.join(checkout, "pages", "page.md");
      fault.error = Object.assign(new Error(`injected ${code}`), { code });
      await expect(publishKnowledgeExport(input(checkout, runner))).rejects.toBe(fault.error);
      expect(fault.attempts).toBe(1);
      expect(calls.map((args) => args[0])).toEqual(["fetch", "show-ref", "checkout", "merge"]);
      expect(calls[1]).toEqual(["show-ref", "--verify", "--quiet", "refs/heads/knowledge-export"]);
      expect(calls[2]).toEqual(["checkout", "knowledge-export"]);
      expect(calls[3]).toEqual(["merge", "--ff-only", "FETCH_HEAD"]);
      expect(await readFile(path.join(checkout, "sentinel.md"))).toEqual(Buffer.from([0, 255, 10]));
    });
  });

  it("writes exact UTF-8 bytes and commits and pushes a changed export", async () => {
    await withCheckout(async (checkout, calls, runner) => {
      const result = await publishKnowledgeExport(input(checkout, runner));
      expect(await readFile(path.join(checkout, "pages", "page.md"))).toEqual(Buffer.from(content, "utf8"));
      expect(result).toEqual({ committed: true, commit: "a".repeat(40), contentHash: tree.contentHash, pageCount: 1 });
      expect(calls.map((args) => args[0])).toEqual(["fetch", "show-ref", "checkout", "merge", "ls-files", "add", "status", "commit", "rev-parse", "push"]);
      expect(calls[1]).toEqual(["show-ref", "--verify", "--quiet", "refs/heads/knowledge-export"]);
      expect(calls[2]).toEqual(["checkout", "knowledge-export"]);
      expect(calls[3]).toEqual(["merge", "--ff-only", "FETCH_HEAD"]);
      expect(calls.at(-1)).toEqual(["push", "origin", "HEAD:knowledge-export"]);
    });
  });
});
