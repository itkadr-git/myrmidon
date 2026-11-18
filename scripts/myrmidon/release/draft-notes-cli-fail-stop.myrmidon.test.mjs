import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../../draft-stable-notes.sh", import.meta.url));
const version = "2026.100.0-beta.0";
const sentinel = Buffer.from([0, 255, 10, 65, 13, 10]);

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "draft-notes-fail-stop-"));
  try {
    const repo = join(root, "repo with spaces");
    const out = join(root, "output with spaces", "notes.md");
    const bin = join(root, "bin");
    const log = join(root, "gh.log");
    mkdirSync(repo);
    mkdirSync(dirname(out));
    mkdirSync(bin);
    writeFileSync(out, sentinel);
    writeFileSync(join(bin, "gh"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$GH_LOG"\nprintf "## What Changed\\n\\n- Enriched detail\\n"\n', { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_LOG: log,
      GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
    delete env.DRAFT_NOTES_SKIP_PR_ENRICHMENT;
    delete env.BASH_ENV;
    const git = (...args) => execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { env, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "feat: control (#42)");
    const invoke = (...args) => spawnSync("bash", [script, ...args], { cwd: root, env, encoding: "utf8" });
    run({ root, repo, out, log, git, invoke });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function unchanged(f) {
  assert.deepEqual(readFileSync(f.out), sentinel);
  assert.equal(existsSync(join(f.repo, "releases")), false);
  assert.equal(existsSync(join(f.root, "releases")), false);
  assert.equal(existsSync(f.log), false);
}

const failures = [
  ["no arguments", () => [], 1, null],
  ["missing out value", f => ["--repo-dir", f.repo, "--out"], 1, "--out requires a path."],
  ["missing repo-dir value", f => ["--out", f.out, "--repo-dir"], 1, "--repo-dir requires a path."],
  ["two versions", f => ["--out", f.out, "--repo-dir", f.repo, version, version], 1, "only one beta version may be provided."],
  ["malformed beta", f => ["--out", f.out, "--repo-dir", f.repo, "2026.100.0"], 1, "beta version must look like 2026.318.1-beta.0, got: 2026.100.0"],
  ["missing beta tag", f => ["--out", f.out, "--repo-dir", f.repo, version], 1, `beta tag beta/v${version} does not exist. Draft notes are generated from a published beta.`],
  ["no version with explicit output", f => ["--out", f.out, "--repo-dir", f.repo], 1, null],
];

for (const [name, args, status, diagnostic] of failures) {
  test(name, () => fixture(f => {
    const result = f.invoke(...args(f));
    assert.ifError(result.error);
    assert.equal(result.status, status);
    if (diagnostic === null) {
      assert.match(result.stdout, /^Usage:\n/);
      assert.equal(result.stderr, "");
    } else {
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, `Error: ${diagnostic}\n`);
    }
    unchanged(f);
  }));
}

for (const flag of ["--help", "-h"]) {
  test(`${flag} prints usage without writing`, () => fixture(f => {
    const result = f.invoke("--out", f.out, "--repo-dir", f.repo, flag);
    assert.ifError(result.error);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^Usage:\n/);
    assert.equal(result.stderr, "");
    unchanged(f);
  }));
}

test("valid tag writes notes and enriches through gh with spaced paths", () => fixture(f => {
  f.git("tag", `beta/v${version}`);
  const sha = f.git("rev-parse", "HEAD");
  const short = f.git("rev-parse", "--short", sha);
  const result = f.invoke(version, "--repo-dir", f.repo, "--out", f.out);
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, `No stable or prior beta tag found; drafting from full history.\nDraft stable notes written to ${f.out}\n  Source beta: ${version} (${sha})\n  Range start: the beginning of history\n`);
  assert.equal(readFileSync(f.out, "utf8"), `# Paperclip stable draft — from beta ${version}\n\n> Auto-generated at beta publish from \`git log the beginning of history..${short}\` (baseline: the beginning of history).\n> Edit freely during the soak: rewrite for release-notes voice,\n> fold noise, and call out anything a self-hoster must act on.\n> The stable promotion reads this file from master and publishes\n> it as the GitHub Release body under the stable version.\n\n## Features\n\n- feat: control (#42)\n  > - Enriched detail\n\n`);
  assert.equal(readFileSync(f.log, "utf8"), "pr view 42 --json body --jq .body\n");
  assert.equal(existsSync(join(f.repo, "releases")), false);
}));
