import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { KnowledgeTreePage } from "./domain.js";
import { createSystemGitRunner, publishKnowledgeExport } from "./git-export-git.js";
import { buildKnowledgeGitTree } from "./git-export.js";

const exec = promisify(execFile);
const branch = "knowledge-export";
const ref = `refs/heads/${branch}`;
const marker = "private-transition-marker";

function page(slug: string, content: string): KnowledgeTreePage {
  return { slug, content, kind: "note", title: slug, summary: null, folder: "ops", tags: [], roles: [], status: "published", approvalRequired: false, approverKind: null };
}

describe("knowledge export life transition remote", () => {
  it("removes a newly private page from the current remote snapshot and stays idempotent", async () => {
    const root = await mkdtemp(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), "knowledge-life-transition-"));
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "empty-config"),
      GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test", GIT_CONFIG_COUNT: "0",
    };
    const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd, env, timeout: 10_000 })).stdout.trim();
    const bare = path.join(root, "remote.git");
    try {
      await git(root, "init", "--bare", bare);
      const moving = page("ops/moving", marker);
      const sentinel = page("ops/sentinel", "public-sentinel-marker");
      const doc = { nestId: "nest-1", pages: [moving, sentinel] };
      const runner = createSystemGitRunner(10_000);
      const publish = (checkout: string, tree: ReturnType<typeof buildKnowledgeGitTree>) => publishKnowledgeExport({
        workDir: path.join(root, checkout), repoUrl: bare, branch, tree, pathPrefix: "company-a", runner, env,
      });
      const initial = buildKnowledgeGitTree(doc);
      expect(initial.pageCount).toBe(2);
      expect(initial.excludedLifePages).toBe(0);
      const first = await publish("first", initial);
      const firstSha = await git(bare, "rev-parse", ref);
      expect(first.committed).toBe(true);
      expect(first.commit).toBe(firstSha);
      expect(await git(bare, "show", `${ref}:company-a/ops/moving.md`)).toContain(marker);
      expect(await git(bare, "show", `${ref}:company-a/README.md`)).toContain("pages: 2");

      const privateTree = buildKnowledgeGitTree({ ...doc, pages: [{ ...moving, folder: "life" }, sentinel] });
      const second = await publish("second", privateTree);
      const secondSha = await git(bare, "rev-parse", ref);
      const paths = await git(bare, "ls-tree", "-r", "--name-only", ref);
      const snapshot = await Promise.all(paths.split("\n").map((file) => git(bare, "show", `${ref}:${file}`)));
      expect(snapshot.join("\n")).not.toContain(marker);
      expect(paths.split("\n")).not.toContain("company-a/ops/moving.md");
      expect(await git(bare, "show", `${ref}:company-a/ops/sentinel.md`)).toContain("public-sentinel-marker");
      expect(privateTree.pageCount).toBe(1);
      expect(privateTree.excludedLifePages).toBe(1);
      expect(second.pageCount).toBe(1);
      expect(second.committed).toBe(true);
      expect(second.commit).toBe(secondSha);
      expect(secondSha).not.toBe(firstSha);
      const readme = await git(bare, "show", `${ref}:company-a/README.md`);
      expect(readme).toContain("pages: 1");
      expect(readme).toContain(`content: ${privateTree.contentHash}`);
      expect(readme).toContain("The private life contour is not included.");

      const third = await publish("third", buildKnowledgeGitTree({ ...doc, pages: [{ ...moving, folder: "life" }, sentinel] }));
      expect(third.committed).toBe(false);
      expect(third.commit).toBeNull();
      expect(await git(bare, "rev-parse", ref)).toBe(secondSha);
      expect(await git(bare, "rev-list", "--count", ref)).toBe("2");
      // This checks only the current snapshot; old commits are not purged or rewritten.
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
