import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
const nestId = "nest-1";
const hash = createHash("sha256").update(`${nestId}\0`).digest("hex");
const readme = [
  "# Knowledge export", "", "Second copy of the knowledge module (KNOWLEDGE-2.0 L-8).",
  "The board database is the source of truth; this tree is rebuilt nightly",
  "and is deterministic: the same pages always produce the same bytes.", "",
  "The private life contour is not included.", "", `nest: ${nestId}`, "pages: 0", `content: ${hash}`, "",
].join("\n");
const page: KnowledgeTreePage = {
  slug: "ops/runbook", title: "Runbook", summary: null, kind: "wiki", folder: "ops", tags: [], roles: [],
  status: "published", approvalRequired: false, approverKind: null, content: "Last article.\n",
};

describe("empty knowledge snapshot to a real remote", () => {
  it.each([false, true])("publishes an empty snapshot (previous article: %s)", async (seedArticle) => {
    const root = await mkdtemp(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), "knowledge-empty-"));
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "empty-config"),
      GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test", GIT_CONFIG_COUNT: "0",
    };
    const git = async (...args: string[]) => (await exec("git", args, { cwd: root, env, timeout: 10_000 })).stdout.trim();
    const bare = path.join(root, "remote.git");
    try {
      await git("init", "--bare", bare);
      const runner = createSystemGitRunner(10_000);
      const publish = (checkout: string, pages: KnowledgeTreePage[]) => publishKnowledgeExport({
        workDir: path.join(root, checkout), repoUrl: bare, branch,
        tree: buildKnowledgeGitTree({ nestId, pages }), pathPrefix: "company-a", runner, env,
      });
      if (seedArticle) {
        const first = await publish("populated", [page]);
        expect(first.committed).toBe(true);
        expect(await git("--git-dir", bare, "ls-tree", "-r", "--name-only", ref, "company-a")).toBe("company-a/README.md\ncompany-a/ops/runbook.md");
      }
      const result = await publish("empty", []);
      const emptySha = await git("--git-dir", bare, "rev-parse", ref);
      expect(result).toEqual({ committed: true, commit: emptySha, contentHash: hash, pageCount: 0 });
      expect(await git("--git-dir", bare, "ls-tree", "-r", "--name-only", ref, "company-a")).toBe("company-a/README.md");
      const shown = await exec("git", ["--git-dir", bare, "show", `${ref}:company-a/README.md`], { cwd: root, env, timeout: 10_000, encoding: "buffer" });
      expect(shown.stdout).toEqual(Buffer.from(readme));
      expect(await git("--git-dir", bare, "rev-list", "--count", ref)).toBe(seedArticle ? "2" : "1");
      const repeated = await publish("empty-again", []);
      expect(repeated).toEqual({ committed: false, commit: null, contentHash: hash, pageCount: 0 });
      expect(await git("--git-dir", bare, "rev-parse", ref)).toBe(emptySha);
      expect(await git("--git-dir", bare, "rev-list", "--count", ref)).toBe(seedArticle ? "2" : "1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
