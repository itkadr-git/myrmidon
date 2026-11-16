import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { publishKnowledgeExport } from "./git-export-git.js";

const exec = promisify(execFile);
const tree = {
  files: [{ path: "page.md", content: "exported\n" }],
  contentHash: "target-branch-test",
  pageCount: 1,
  excludedLifePages: 0,
};

async function git(cwd: string, ...args: string[]) {
  return (await exec("git", args, { cwd })).stdout.trim();
}

async function fixture(run: (remote: string, checkout: string) => Promise<void>) {
  const root = await mkdtemp(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), "knowledge-target-"));
  try {
    const remote = path.join(root, "remote.git");
    const checkout = path.join(root, "checkout");
    await git(root, "init", "--bare", remote);
    await mkdir(checkout);
    await git(checkout, "init", "-b", "target");
    await git(checkout, "config", "user.name", "Test");
    await git(checkout, "config", "user.email", "test@example.test");
    await writeFile(path.join(checkout, "target-only.txt"), "target\n");
    await git(checkout, "add", ".");
    await git(checkout, "commit", "-m", "target base");
    await git(checkout, "remote", "add", "origin", remote);
    await git(checkout, "push", "-u", "origin", "target");
    await run(remote, checkout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("knowledge export target branch", () => {
  it("publishes on the fetched target without committing on another branch", async () => {
    await fixture(async (remote, checkout) => {
      await git(checkout, "checkout", "-b", "other");
      await writeFile(path.join(checkout, "other-only.txt"), "other\n");
      await git(checkout, "add", ".");
      await git(checkout, "commit", "-m", "other base");
      const otherBefore = await git(checkout, "rev-parse", "other");
      const result = await publishKnowledgeExport({ workDir: checkout, repoUrl: remote, branch: "target", tree, pathPrefix: "company" });
      expect(result.committed).toBe(true);
      expect(await git(checkout, "rev-parse", "other")).toBe(otherBefore);
      expect(await git(remote, "show", "target:target-only.txt")).toBe("target");
      expect(await git(remote, "show", "target:company/page.md")).toBe("exported");
      expect(await git(remote, "ls-tree", "--name-only", "target")).not.toContain("other-only.txt");
    });
  });

  it("publishes successfully when the target is already checked out", async () => {
    await fixture(async (remote, checkout) => {
      const result = await publishKnowledgeExport({ workDir: checkout, repoUrl: remote, branch: "target", tree, pathPrefix: "company" });
      expect(result.committed).toBe(true);
      expect(await readFile(path.join(checkout, "company/page.md"), "utf8")).toBe("exported\n");
      expect(await git(remote, "show", "target:target-only.txt")).toBe("target");
      expect(await git(remote, "show", "target:company/page.md")).toBe("exported");
    });
  });
});
