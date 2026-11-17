import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { commitKnowledgeTreeIfChanged, type GitExportRunner } from "./git-export-git.js";
import type { KnowledgeGitTree } from "./git-export.js";

const tree: KnowledgeGitTree = {
  files: [{ path: "nested/page.md", content: "exported content\n" }],
  contentHash: "0123456789abcdef",
  pageCount: 1,
  excludedLifePages: 0,
};

async function snapshot(dir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result[`${entry.name}/`] = "directory";
      for (const [name, value] of Object.entries(await snapshot(full))) result[`${entry.name}/${name}`] = value;
    } else {
      result[entry.name] = (await readFile(full)).toString("hex");
    }
  }
  return result;
}

async function withScratch(run: (root: string, checkout: string) => Promise<void>) {
  const base = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.HOME;
  if (!base) throw new Error("No permitted scratch directory");
  const root = await mkdtemp(path.join(base, "knowledge-prefix-"));
  try {
    const checkout = path.join(root, "checkout");
    await mkdir(checkout);
    await writeFile(path.join(checkout, "inside-sentinel"), Buffer.from([0, 255, 1]));
    await writeFile(path.join(root, "outside-sentinel"), Buffer.from([254, 0, 2]));
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
      return { stdout: args[0] === "status" ? (args.includes("-z") ? "" : "?? page.md\n") : args[0] === "rev-parse" ? `${"a".repeat(40)}\n` : "", stderr: "" };
    },
  };
  return { runner, calls };
}

describe("knowledge export unsafe prefix preflight", () => {
  it.each(["../escape", "slash/path", "/absolute/path", ".", "..", " ", "company\0id"])(
    "rejects prefix %j before writes or git calls",
    async (prefix) => {
      await withScratch(async (root, checkout) => {
        const before = await snapshot(root);
        const { runner, calls } = recordingRunner();
        await expect(commitKnowledgeTreeIfChanged(runner, checkout, "knowledge-export", tree, undefined, prefix))
          .rejects.toThrow(/unsafe path prefix/);
        expect(await snapshot(root)).toEqual(before);
        expect(calls).toEqual([]);
      });
    },
  );

  it.each(["company-1", "company_2.3"])("writes only inside valid namespace %s", async (prefix) => {
    await withScratch(async (root, checkout) => {
      const before = await snapshot(root);
      const { runner, calls } = recordingRunner();
      const result = await commitKnowledgeTreeIfChanged(runner, checkout, "knowledge-export", tree, undefined, prefix);
      expect(result).toEqual({ committed: true, commit: "a".repeat(40) });
      expect(await snapshot(root)).toEqual({
        ...before,
        [`checkout/${prefix}/`]: "directory",
        [`checkout/${prefix}/nested/`]: "directory",
        [`checkout/${prefix}/nested/page.md`]: Buffer.from("exported content\n").toString("hex"),
      });
      expect(calls).toEqual([...(prefix ? ["status"] : []), "ls-files", "add", "status", "commit", "rev-parse"]);
    });
  });
});
