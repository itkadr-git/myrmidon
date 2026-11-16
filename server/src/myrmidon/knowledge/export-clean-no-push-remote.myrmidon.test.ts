import { execFile } from "node:child_process";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { KnowledgeTreePage } from "./domain.js";
import { buildKnowledgeGitTree } from "./git-export.js";
import { publishKnowledgeExport } from "./git-export-git.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

function tree(content: string) {
  const page: KnowledgeTreePage = {
    slug: "ops/runbook", title: "Runbook", summary: null, kind: "wiki", folder: "ops",
    tags: [], roles: [], status: "published", approvalRequired: false, approverKind: null, content,
  };
  return buildKnowledgeGitTree({ nestId: "nest-1", pages: [page] });
}

describe("knowledge export to a remote", () => {
  it("does not push an unchanged snapshot, but pushes a changed one", async () => {
    const root = await mkdtemp(path.join(process.env.RUN_SCRATCH_DIR ?? process.env.SCRATCH_DIR ?? os.homedir(), "knowledge-no-push-"));
    const remote = path.join(root, "remote.git");
    const hook = path.join(remote, "hooks", "pre-receive");
    const marker = path.join(remote, "hooks", "push-marker");
    try {
      await git(root, "init", "--bare", remote);
      const input = { workDir: path.join(root, "checkout"), repoUrl: remote, branch: "knowledge-export", tree: tree("first\n") };
      const first = await publishKnowledgeExport(input);
      expect(first.committed).toBe(true);
      expect(first.commit).toMatch(/^[0-9a-f]{40}$/);
      const remoteSha = await git(remote, "rev-parse", "refs/heads/knowledge-export");
      expect(remoteSha).toBe(first.commit);

      await writeFile(hook, '#!/bin/sh\nprintf "received\\n" > "$(dirname "$0")/push-marker"\nexit 1\n');
      await chmod(hook, 0o755);
      const unchanged = await publishKnowledgeExport(input);
      expect(unchanged.committed).toBe(false);
      expect(unchanged.commit).toBeNull();
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await git(remote, "rev-parse", "refs/heads/knowledge-export")).toBe(remoteSha);

      await expect(publishKnowledgeExport({ ...input, tree: tree("changed\n") })).rejects.toThrow(/pre-receive hook declined/);
      await expect(access(marker)).resolves.toBeUndefined();
      expect(await git(remote, "rev-parse", "refs/heads/knowledge-export")).toBe(remoteSha);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
