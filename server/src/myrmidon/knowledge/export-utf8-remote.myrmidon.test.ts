import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { KnowledgeTreeDoc } from "./domain.js";
import { createSystemGitRunner, publishKnowledgeExport } from "./git-export-git.js";
import { buildKnowledgeGitTree } from "./git-export.js";

const exec = promisify(execFile);

describe("knowledge export UTF-8 remote", () => {
  it("preserves markdown bytes and README across fresh exports", async () => {
    const root = await mkdtemp(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), "knowledge-utf8-"));
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "empty-config"),
      GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "0",
      GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test",
    };
    const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd, env, timeout: 10_000 })).stdout.trim();
    const bare = path.join(root, "remote.git");
    const branch = "knowledge-export";
    const ref = `refs/heads/${branch}`;
    const doc: KnowledgeTreeDoc = { nestId: "fixture", pages: [{
      slug: "руководства/настройка", kind: "wiki", title: 'Привет "мир"', summary: null,
      folder: "руководства", tags: ["тест"], roles: [], status: "published",
      approvalRequired: false, approverKind: null, content: 'Первая "строка"\r\n第二行\r\n',
    }] };
    const expected = Buffer.from(
      '---\nslug: "руководства/настройка"\nkind: "wiki"\ntitle: "Привет \\\"мир\\\""\nsummary: null\nfolder: "руководства"\ntags: ["тест"]\nstatus: "published"\napproval_required: false\napprover_kind: null\n---\n\nПервая "строка"\r\n第二行\r\n',
      "utf8",
    );
    try {
      await git(root, "init", "--bare", bare);
      const runner = createSystemGitRunner(10_000);
      const publish = (checkout: string) => publishKnowledgeExport({
        workDir: path.join(root, checkout), repoUrl: bare, branch, tree: buildKnowledgeGitTree(doc), pathPrefix: "company-a", runner, env,
      });
      const first = await publish("checkout-a");
      const sha = await git(bare, "rev-parse", "--verify", ref);
      expect(first.committed).toBe(true);
      expect(first.commit).toBe(sha);
      const show = async (file: string) => (await exec("git", ["show", `${ref}:${file}`], { cwd: bare, env, timeout: 10_000, encoding: "buffer" })).stdout;
      expect(await show("company-a/руководства/настройка.md")).toEqual(expected);
      const readme = await show("company-a/README.md");
      expect(readme.toString("utf8")).toContain("# Knowledge export\n");
      expect(readme).not.toEqual(expected);
      const second = await publish("checkout-b");
      expect(second.committed).toBe(false);
      expect(second.commit).toBeNull();
      expect(await git(bare, "rev-parse", "--verify", ref)).toBe(sha);
      expect(await git(bare, "rev-list", "--count", ref)).toBe("1");
      expect(await show("company-a/руководства/настройка.md")).toEqual(expected);
      expect(await show("company-a/README.md")).toEqual(readme);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
