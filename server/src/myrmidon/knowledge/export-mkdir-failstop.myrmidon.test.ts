import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { commitKnowledgeTreeIfChanged, type GitExportRunner } from "./git-export-git.js";
import type { KnowledgeGitTree } from "./git-export.js";

const observed = vi.hoisted(() => ({ failDir: "", mkdirCalls: [] as string[], writeCalls: [] as string[], stats: [] as string[] }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    lstat: async (...args: Parameters<typeof fs.lstat>) => {
      observed.stats.push(String(args[0]));
      return fs.lstat(...args);
    },
    mkdir: async (...args: Parameters<typeof fs.mkdir>) => {
      observed.mkdirCalls.push(String(args[0]));
      if (String(args[0]) === observed.failDir) {
        throw Object.assign(new Error("injected mkdir failure"), { code: "EACCES" });
      }
      return fs.mkdir(...args);
    },
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      observed.writeCalls.push(String(args[0]));
      return fs.writeFile(...args);
    },
  };
});

const content = "nested page\n\u0000 unicode: \u00e9\n";
const tree: KnowledgeGitTree = {
  files: [{ path: "nested/page.md", content }], contentHash: "0123456789abcdef", pageCount: 1, excludedLifePages: 0,
};

async function withCheckout(run: (checkout: string) => Promise<void>) {
  const base = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.HOME;
  if (!base) throw new Error("No permitted scratch directory");
  const root = await mkdtemp(path.join(base, "knowledge-mkdir-"));
  try {
    const checkout = path.join(root, "checkout");
    await mkdir(checkout);
    await run(checkout);
  } finally {
    observed.failDir = "";
    await rm(root, { recursive: true, force: true });
  }
}

function recordingRunner() {
  const calls: string[] = [];
  const runner: GitExportRunner = {
    async git(_cwd, args) {
      calls.push(args[0]!);
      return { stdout: "", stderr: "" };
    },
  };
  return { runner, calls };
}

describe("knowledge export page directory failure", () => {
  it("stops before writing or calling git when nested mkdir fails", async () => {
    await withCheckout(async (checkout) => {
      const sentinel = path.join(checkout, "sentinel.bin");
      const original = Buffer.from([0, 255, 10, 42]);
      await writeFile(sentinel, original);
      const nested = path.join(checkout, "nested");
      const page = path.join(nested, "page.md");
      observed.failDir = nested;
      observed.mkdirCalls = [];
      observed.writeCalls = [];
      observed.stats = [];
      const { runner, calls } = recordingRunner();

      await expect(commitKnowledgeTreeIfChanged(runner, checkout, "export", tree)).rejects.toMatchObject({ code: "EACCES" });
      expect(observed.stats).toEqual([checkout, nested, page]);
      expect(observed.mkdirCalls).toEqual([nested]);
      expect(observed.writeCalls).not.toContain(page);
      expect(calls).toEqual([]);
      expect(await readFile(sentinel)).toEqual(original);
    });
  });

  it("creates the nested page with its exact bytes when mkdir succeeds", async () => {
    await withCheckout(async (checkout) => {
      const { runner, calls } = recordingRunner();
      const result = await commitKnowledgeTreeIfChanged(runner, checkout, "export", tree);
      expect(await readFile(path.join(checkout, "nested/page.md"))).toEqual(Buffer.from(content));
      expect(result).toEqual({ committed: false, commit: null });
      expect(calls).toEqual(["ls-files", "add", "status"]);
    });
  });
});
