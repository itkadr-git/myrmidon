import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { commentBody, judge, run } from "./docs-reminder.mjs";

// DOCS-WRITER-RULES (OPE-12243): unit tests of the non-blocking reminder.
// The decision part (judge) runs on synthetic file lists; the full run()
// path uses a sandbox git repository (base commit + PR-range commit) and fake
// list/post callbacks — no network, no real PR. Covers the four false-if
// criteria: no failure exit, exactly one comment on a trigger diff, no comment
// when a fragment is in the diff, no duplicate on a second call.

const HERE = path.dirname(fileURLToPath(import.meta.url));

function git(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

/** A git repo with one base commit; apply() adds commits on top. */
function gitSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docs-reminder-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "agent-a@example.com"]);
  git(dir, ["config", "user.name", "agent-a"]);
  fs.mkdirSync(path.join(dir, "docs/myrmidon/changes"), { recursive: true });
  fs.mkdirSync(path.join(dir, "packages/paperclip-runner/generated/capability"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(dir, "packages/paperclip-runner/generated/capability/capabilities.yaml"),
    "capabilities: []\n",
  );
  fs.writeFileSync(path.join(dir, "docs/myrmidon/changes/README.md"), "# fragments\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-qm", "base"]);
  const base = git(dir, ["rev-parse", "HEAD"]);
  return {
    dir,
    base,
    apply(files) {
      for (const [rel, text] of Object.entries(files)) {
        const target = path.join(dir, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, text);
      }
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-qm", "change"]);
      return git(dir, ["rev-parse", "HEAD"]);
    },
  };
}

describe("judge", () => {
  it("a generated/capability change without docs reminds", () => {
    const v = judge([
      "packages/paperclip-runner/generated/capability/capabilities.yaml",
      "ui/src/x.ts",
    ]);
    assert.equal(v.remind, true);
    assert.deepEqual(v.triggerFiles, [
      "packages/paperclip-runner/generated/capability/capabilities.yaml",
    ]);
  });

  it("a server route schema change without docs reminds", () => {
    const v = judge(["server/src/routes/cases-schemas.ts"]);
    assert.equal(v.remind, true);
  });

  it("a server service schema change without docs reminds", () => {
    const v = judge(["server/src/services/json-schema-secret-refs.ts"]);
    assert.equal(v.remind, true);
  });

  it("a non-schema .json change under server/ does not remind", () => {
    const v = judge(["server/src/data/some-config.json"]);
    assert.equal(v.remind, false);
  });

  it("an agent schema change without docs reminds", () => {
    const v = judge([".agents/schemas/new.json"]);
    assert.equal(v.remind, true);
  });

  it("a docs-only change does not remind (false positive forbidden)", () => {
    const v = judge(["docs/myrmidon/changes/some-slug.md"]);
    assert.equal(v.remind, false);
    assert.equal(v.triggerFiles.length, 0);
  });

  it("a trigger change WITH a fragment in the diff does not remind", () => {
    const v = judge([
      "packages/paperclip-runner/generated/capability/capabilities.yaml",
      "docs/myrmidon/changes/some-slug.md",
    ]);
    assert.equal(v.remind, false);
    assert.equal(v.triggerFiles.length, 1);
    assert.equal(v.docsFiles.length, 1);
  });

  it("a trigger change WITH a skill reference in the diff does not remind", () => {
    const v = judge([
      "server/src/services/json-schema-secret-refs.ts",
      "skills/myrmidon/references/api-reference.md",
    ]);
    assert.equal(v.remind, false);
  });

  it("README.md under fragments/ counts as docs (no false positive)", () => {
    const v = judge([
      "packages/paperclip-runner/generated/capability/capabilities.yaml",
      "docs/myrmidon/changes/README.md",
    ]);
    assert.equal(v.remind, false);
  });

  it("an unrelated code change does not remind", () => {
    const v = judge(["ui/src/pages/Home.tsx", "server/src/services/foo.ts"]);
    assert.equal(v.remind, false);
  });

  it("never reports a reminder for an empty diff", () => {
    const v = judge([]);
    assert.equal(v.remind, false);
  });
});

describe("commentBody", () => {
  it("carries the marker and points to the fragment README and skill references", () => {
    const body = commentBody({
      triggerFiles: ["packages/paperclip-runner/generated/capability/capabilities.yaml"],
    });
    assert.match(body, /^<!-- docs-reminder -->/);
    assert.match(body, /docs\/myrmidon\/changes\/README\.md/);
    assert.match(body, /skills\/myrmidon\/references\//);
    assert.match(body, /never fails CI/);
  });

  it("caps the listed files and notes the remainder", () => {
    const files = Array.from({ length: 12 }, (_, i) => `server/schema-${i}.ts`);
    const body = commentBody({ triggerFiles: files });
    assert.match(body, /and 2 more/);
  });
});

describe("run (sandbox git + fake GitHub API)", () => {
  it("posts exactly one comment on a trigger diff without docs", async () => {
    const s = gitSandbox();
    const head = s.apply({
      "packages/paperclip-runner/generated/capability/capabilities.yaml": "capabilities: [a]\n",
    });
    const posted = [];
    const out = await run({
      root: s.dir,
      token: "fake",
      prNumber: 42,
      base: s.base,
      head,
      repo: "owner/repo",
      list: async () => [],
      post: async (_api, _repo, _pr, _token, body) => {
        posted.push(body);
        return { id: 7 };
      },
    });
    assert.equal(out.status, "posted");
    assert.equal(out.commentId, 7);
    assert.equal(posted.length, 1);
    assert.match(posted[0], /^<!-- docs-reminder -->/);
  });

  it("skips when the marker comment already exists (second push: no duplicate)", async () => {
    const s = gitSandbox();
    const head = s.apply({
      "packages/paperclip-runner/generated/capability/capabilities.yaml": "capabilities: [a]\n",
    });
    const posted = [];
    const out = await run({
      root: s.dir,
      token: "fake",
      prNumber: 42,
      base: s.base,
      head,
      repo: "owner/repo",
      list: async () => [{ id: 7, body: "<!-- docs-reminder -->\nold hint", user: { login: "github-actions[bot]" } }],
      post: async (_api, _repo, _pr, _token, body) => {
        posted.push(body);
        return { id: 8 };
      },
    });
    assert.equal(out.status, "already-posted");
    assert.equal(out.commentId, 7);
    assert.equal(posted.length, 0);
  });

  it("ignores a marker comment by a human, not the bot", async () => {
    const s = gitSandbox();
    const head = s.apply({
      "packages/paperclip-runner/generated/capability/capabilities.yaml": "capabilities: [a]\n",
    });
    const posted = [];
    const out = await run({
      root: s.dir,
      token: "fake",
      prNumber: 42,
      base: s.base,
      head,
      repo: "owner/repo",
      list: async () => [{ id: 9, body: "<!-- docs-reminder --> quoted by a human", user: { login: "humandev" } }],
      post: async () => {
        posted.push("x");
        return { id: 10 };
      },
    });
    assert.equal(out.status, "posted");
    assert.equal(posted.length, 1);
  });

  it("does not post when the PR diff includes a change fragment", async () => {
    const s = gitSandbox();
    const head = s.apply({
      "packages/paperclip-runner/generated/capability/capabilities.yaml": "capabilities: [a]\n",
      "docs/myrmidon/changes/some-slug.md": "## changelog-en\n\n### Title (OPE-1)\n",
    });
    const posted = [];
    const out = await run({
      root: s.dir,
      token: "fake",
      prNumber: 42,
      base: s.base,
      head,
      repo: "owner/repo",
      list: async () => [],
      post: async () => {
        posted.push("x");
        return { id: 1 };
      },
    });
    assert.equal(out.status, "no-reminder");
    assert.equal(posted.length, 0);
  });

  it("silently skips without token/PR data (fork path never fails)", async () => {
    const s = gitSandbox();
    const out = await run({
      root: s.dir,
      token: "",
      prNumber: "",
      base: s.base,
      head: s.base,
      repo: "",
    });
    assert.equal(out.status, "skipped");
  });
});

describe("CLI never exits non-zero on the reminder verdict", () => {
  it("exits 0 with no env at all", () => {
    const r = execFileSync("node", [path.join(HERE, "docs-reminder.mjs")], {
      cwd: gitSandbox().dir,
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    });
    assert.match(r, /docs-reminder: skipped/);
  });

  it("exits 0 on a trigger diff with a dead GitHub endpoint", () => {
    const s = gitSandbox();
    const head = s.apply({
      "packages/paperclip-runner/generated/capability/capabilities.yaml": "capabilities: [a]\n",
    });
    const r = execFileSync("node", [path.join(HERE, "docs-reminder.mjs")], {
      cwd: s.dir,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        GITHUB_TOKEN: "fake",
        PR_NUMBER: "42",
        BASE_SHA: s.base,
        HEAD_SHA: head,
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_API_URL: "http://127.0.0.1:9",
      },
    });
    // connection refused is swallowed, CI stays green by construction
    assert.match(r, /docs-reminder: skipped/);
  });
});
