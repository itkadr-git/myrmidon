// server/src/myrmidon/knowledge/git-export.myrmidon.test.ts
//
// myrmidon(1.7 KNOWLEDGE-2.0 L-8): the nightly git export.
//
// What this pins:
//   - the same pages in any order produce the same bytes and the same hash;
//   - the life contour (I-7) never appears in a file;
//   - a second publish of an unchanged tree does not commit;
//   - a changed page does commit, and the removed page is deleted;
//   - with the repo env unset the pass does not list companies.

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { KnowledgeTreeDoc, KnowledgeTreePage } from "./domain.js";
import {
  buildKnowledgeGitTree,
  isLifeKnowledgePath,
  knowledgeExportCommitMessage,
  readKnowledgeExportSettings,
} from "./git-export.js";
import { commitKnowledgeTreeIfChanged, type GitExportRunner } from "./git-export-git.js";
import { runKnowledgeExportPass } from "./git-export-job.js";

const execFileAsync = promisify(execFile);

const page = (over: Partial<KnowledgeTreePage> = {}): KnowledgeTreePage => ({
  slug: "ops/runbook",
  title: "Runbook",
  summary: null,
  kind: "wiki",
  folder: "ops",
  tags: ["oncall"],
  status: "published",
  approvalRequired: false,
  approverKind: null,
  content: "Step one.\n",
  ...over,
});

function doc(pages: KnowledgeTreePage[]): KnowledgeTreeDoc {
  return { nestId: "nest-1", pages };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd });
  return String(result.stdout ?? "");
}

async function initRepo(dir: string): Promise<void> {
  await git(dir, ["init", "-b", "knowledge-export"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Test"]);
}

const systemRunner: GitExportRunner = {
  async git(cwd, args, env) {
    const result = await execFileAsync("git", args, { cwd, env: { ...process.env, ...env } });
    return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
  },
};

describe("knowledge git export — deterministic tree", () => {
  it("sorts pages and ignores input order", () => {
    const a = page({ slug: "a/one", title: "One", folder: "a" });
    const b = page({ slug: "b/two", title: "Two", folder: "b", content: "two\n" });
    const left = buildKnowledgeGitTree(doc([b, a]));
    const right = buildKnowledgeGitTree(doc([a, b]));
    expect(left.contentHash).toBe(right.contentHash);
    expect(left.files.map((file) => file.path)).toEqual(right.files.map((file) => file.path));
    expect(left.files.map((file) => file.content).join("\n")).toBe(right.files.map((file) => file.content).join("\n"));
  });

  it("renders stable frontmatter and keeps content bytes", () => {
    const tree = buildKnowledgeGitTree(doc([page({ content: "line\n--- item ---\nstill content\n" })]));
    const body = tree.files.find((file) => file.path === "ops/runbook.md")?.content ?? "";
    expect(body.startsWith("---\nslug: \"ops/runbook\"\nkind: \"wiki\"\n")).toBe(true);
    expect(body).toContain("line\n--- item ---\nstill content\n");
    expect(knowledgeExportCommitMessage(tree)).toContain(tree.contentHash.slice(0, 12));
  });

  it("drops the life contour and nothing else (I-7)", () => {
    expect(isLifeKnowledgePath("directions/life", "private-note")).toBe(true);
    expect(isLifeKnowledgePath("", "life/note")).toBe(true);
    expect(isLifeKnowledgePath("directions", "ops")).toBe(false);
    const tree = buildKnowledgeGitTree(
      doc([
        page(),
        page({ slug: "directions/life/note", folder: "directions/life", title: "Private", content: "secret life text\n" }),
        page({ slug: "life", folder: "", title: "Life root", content: "also private\n" }),
      ]),
    );
    expect(tree.excludedLifePages).toBe(2);
    expect(tree.pageCount).toBe(1);
    const blob = tree.files.map((file) => file.content).join("\n");
    expect(blob).not.toContain("secret life text");
    expect(blob).not.toContain("also private");
    expect(tree.files.map((file) => file.path)).toEqual(["README.md", "ops/runbook.md"]);
  });

  it("is off unless the repo env is set, and rejects a branch with ..", () => {
    expect(readKnowledgeExportSettings({}).enabled).toBe(false);
    const on = readKnowledgeExportSettings({
      MYRMIDON_KNOWLEDGE_EXPORT_REPO: "https://example.test/knowledge-export.git",
      MYRMIDON_KNOWLEDGE_EXPORT_BRANCH: "refs/../heads/main",
      MYRMIDON_KNOWLEDGE_EXPORT_INTERVAL_HOURS: "12",
    });
    expect(on.enabled).toBe(true);
    expect(on.branch).toBe("knowledge-export");
    expect(on.intervalHours).toBe(12);
  });
});

describe("knowledge git export — commit only when bytes change", () => {
  it("commits once, then stays quiet, then commits a change and deletes a removed page", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kexport-"));
    try {
      await initRepo(dir);
      const first = buildKnowledgeGitTree(doc([page(), page({ slug: "ops/other", title: "Other", content: "other\n" })]));
      const created = await commitKnowledgeTreeIfChanged(systemRunner, dir, "knowledge-export", first);
      expect(created.committed).toBe(true);
      expect(created.commit).toMatch(/^[0-9a-f]{40}$/);

      const again = await commitKnowledgeTreeIfChanged(systemRunner, dir, "knowledge-export", first);
      expect(again.committed).toBe(false);
      expect(again.commit).toBeNull();
      const logAfterQuiet = await git(dir, ["rev-list", "--count", "HEAD"]);
      expect(logAfterQuiet.trim()).toBe("1");

      const changed = buildKnowledgeGitTree(doc([page({ content: "step one, revised\n" })]));
      const second = await commitKnowledgeTreeIfChanged(systemRunner, dir, "knowledge-export", changed);
      expect(second.committed).toBe(true);
      const tracked = (await git(dir, ["ls-files"])).trim().split("\n").sort();
      expect(tracked).toEqual(["README.md", "ops/runbook.md"]);
      const log = await git(dir, ["log", "--format=%s"]);
      expect(log).toContain(changed.contentHash.slice(0, 12));
      expect(log.split("\n").filter((line) => line.includes(first.contentHash.slice(0, 12)))).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("knowledge git export — the nightly pass", () => {
  it("does not touch companies when the switch is off", async () => {
    let listed = false;
    const result = await runKnowledgeExportPass({} as never, {
      settings: { enabled: false, repoUrl: null, branch: "knowledge-export", intervalHours: 24 },
      ports: {
        listCompanyIds: async () => {
          listed = true;
          return ["c1"];
        },
      },
    });
    expect(result.enabled).toBe(false);
    expect(listed).toBe(false);
  });

  it("publishes one company and counts an unchanged second company", async () => {
    const published: string[] = [];
    const result = await runKnowledgeExportPass({} as never, {
      settings: {
        enabled: true,
        repoUrl: "https://example.test/knowledge-export.git",
        branch: "knowledge-export",
        intervalHours: 24,
      },
      ports: {
        listCompanyIds: async () => ["c1"],
        exportCompany: async () => {
          const { serializeKnowledgeTree } = await import("./domain.js");
          return serializeKnowledgeTree(doc([page()]));
        },
        publish: async (input) => {
          published.push(input.companyId);
          expect(input.tree.pageCount).toBe(1);
          expect(input.tree.files.some((file) => file.path === "ops/runbook.md")).toBe(true);
          return { committed: false, commit: null, contentHash: input.tree.contentHash, pageCount: 1 };
        },
      },
    });
    expect(published).toEqual(["c1"]);
    expect(result).toMatchObject({ enabled: true, companies: 1, committed: 0, unchanged: 1, failed: 0 });
  });

  it("keeps going when one company fails", async () => {
    const result = await runKnowledgeExportPass({} as never, {
      settings: {
        enabled: true,
        repoUrl: "https://example.test/knowledge-export.git",
        branch: "knowledge-export",
        intervalHours: 24,
      },
      ports: {
        listCompanyIds: async () => ["bad", "good"],
        exportCompany: async (_db, companyId) => {
          if (companyId === "bad") throw new Error("db down");
          const { serializeKnowledgeTree } = await import("./domain.js");
          return serializeKnowledgeTree(doc([page()]));
        },
        publish: async (input) => ({ committed: true, commit: "abc", contentHash: input.tree.contentHash, pageCount: 1 }),
        log: { info() {}, warn() {}, error() {} },
      },
    });
    expect(result).toMatchObject({ companies: 2, committed: 1, failed: 1 });
  });
});
