import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createSystemGitRunner, publishKnowledgeExport } from "./git-export-git.js";
import type { KnowledgeGitTree } from "./git-export.js";

const exec = promisify(execFile);
const branch = "knowledge-export";
const ref = `refs/heads/${branch}`;

function tree(content: string, readme: string): KnowledgeGitTree {
  return {
    files: [{ path: "ops/runbook.md", content }, { path: "README.md", content: readme }],
    contentHash: "fixture-hash", pageCount: 1, excludedLifePages: 0,
  };
}

describe("knowledge export shared remote", () => {
  it("preserves other companies and unrelated files across fresh checkouts", async () => {
    const root = await mkdtemp(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), "knowledge-multicompany-"));
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "empty-config"),
      GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test", GIT_CONFIG_COUNT: "0",
    };
    const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd, env, timeout: 10_000 })).stdout.trim();
    const bare = path.join(root, "remote.git");
    const show = async (file: string) => (await exec("git", ["show", `${ref}:${file}`], { cwd: bare, env, timeout: 10_000, encoding: "buffer" })).stdout;
    try {
      await git(root, "init", "--bare", bare);
      const seed = path.join(root, "seed");
      await mkdir(seed);
      await git(seed, "init", "-b", branch);
      await writeFile(path.join(seed, "sentinel.txt"), "foreign sentinel\n");
      await git(seed, "add", "sentinel.txt");
      await git(seed, "commit", "-m", "seed");
      await git(seed, "push", bare, `HEAD:${ref}`);
      const runner = createSystemGitRunner(10_000);
      const publish = (checkout: string, prefix: string, content: string, readme: string) => publishKnowledgeExport({
        workDir: path.join(root, checkout), repoUrl: bare, branch, tree: tree(content, readme), pathPrefix: prefix, runner, env,
      });
      const a = "company A original\n";
      const updatedA = "company A updated\nsecond line\n";
      const aReadme = "A index\n";
      const b = "company B content\n";
      const bReadme = "B index\n";
      expect((await publish("checkout-a", "company-a", a, aReadme)).committed).toBe(true);
      expect((await publish("checkout-b", "company-b", b, bReadme)).committed).toBe(true);
      expect(await show("company-a/ops/runbook.md")).toEqual(Buffer.from(a));
      expect(await show("company-a/README.md")).toEqual(Buffer.from(aReadme));
      expect(await show("company-b/ops/runbook.md")).toEqual(Buffer.from(b));
      expect(await show("company-b/README.md")).toEqual(Buffer.from(bReadme));
      expect(await show("sentinel.txt")).toEqual(Buffer.from("foreign sentinel\n"));
      expect((await publish("checkout-c", "company-a", updatedA, aReadme)).committed).toBe(true);
      expect(await git(bare, "ls-tree", "-r", "--name-only", ref)).toBe([
        "company-a/README.md", "company-a/ops/runbook.md", "company-b/README.md", "company-b/ops/runbook.md", "sentinel.txt",
      ].join("\n"));
      expect(await show("company-a/ops/runbook.md")).toEqual(Buffer.from(updatedA));
      expect(await show("company-a/README.md")).toEqual(Buffer.from(aReadme));
      expect(await show("company-b/ops/runbook.md")).toEqual(Buffer.from(b));
      expect(await show("company-b/README.md")).toEqual(Buffer.from(bReadme));
      expect(await show("sentinel.txt")).toEqual(Buffer.from("foreign sentinel\n"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
