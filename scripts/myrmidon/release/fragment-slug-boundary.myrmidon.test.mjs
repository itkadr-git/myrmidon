import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./fragments-from-diff.mjs", import.meta.url));
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(os.homedir(), ".cache");
const git = fs.existsSync("/usr/bin/git") ? "/usr/bin/git" : "git";
const env = {
  PATH: "/usr/bin:/bin",
  HOME: scratch,
  TMPDIR: scratch,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

function command(executable, args, cwd) {
  const result = spawnSync(executable, args, { cwd, env, encoding: "utf8", timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

function snapshot(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? [entry.name, snapshot(file)] : [entry.name, fs.readFileSync(file).toString("hex")];
  });
}

test("unsafe slugs fail before git or filesystem writes", () => {
  fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, "slug-boundary-"));
  try {
    const root = path.join(dir, "missing-root");
    const sentinel = path.join(dir, "sentinel");
    fs.writeFileSync(sentinel, Buffer.from([0, 1, 127, 255]));
    const before = snapshot(dir);
    for (const slug of ["../escape", path.join(dir, "absolute"), "a b", "a/b", "Upper", ""]) {
      const result = command(process.execPath, [script, "--root", root, "--slug", slug], dir);
      assert.equal(result.status, slug === "" ? 2 : 1, JSON.stringify(slug));
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, slug === ""
        ? "usage: fragments-from-diff.mjs --slug <slug> [--base origin/main] [--head HEAD] [--root <dir>] [--revert] [--dry-run] [--no-verify] [--force]\n"
        : "fragments-from-diff: --slug must be lowercase latin letters, digits and hyphens\n", JSON.stringify(slug));
      assert.deepEqual(snapshot(dir), before, JSON.stringify(slug));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("valid slugs create distinct fragments from a real git diff", () => {
  fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, "slug-positive-"));
  try {
    const root = path.join(dir, "repo");
    fs.mkdirSync(root);
    const runGit = (...args) => {
      const result = command(git, args, root);
      assert.equal(result.status, 0, result.stderr);
    };
    runGit("init", "-q", "-b", "main");
    const changelog = path.join(root, "docs/myrmidon/CHANGELOG.md");
    fs.mkdirSync(path.dirname(changelog), { recursive: true });
    fs.writeFileSync(changelog, "# Changelog\n\n## Unreleased\n\n## 1.0.0\n");
    runGit("add", ".");
    runGit("commit", "-q", "-m", "base");
    runGit("checkout", "-q", "-b", "feature");
    fs.writeFileSync(changelog, "# Changelog\n\n## Unreleased\n\n### Feature\n\n- Added.\n\n## 1.0.0\n");
    runGit("add", ".");
    runGit("commit", "-q", "-m", "feature");
    const sentinel = path.join(dir, "sentinel");
    const sentinelBytes = Buffer.from([0, 1, 127, 255]);
    fs.writeFileSync(sentinel, sentinelBytes);
    for (const slug of ["a", "a-2"]) {
      const result = command(process.execPath, [script, "--root", root, "--base", "main", "--slug", slug, "--no-verify"], dir);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.equal(result.stdout, `wrote docs/myrmidon/changes/${slug}.md\n`);
      assert.equal(fs.readFileSync(path.join(root, `docs/myrmidon/changes/${slug}.md`), "utf8"), "## changelog-en\n\n### Feature\n\n- Added.\n");
      assert.deepEqual(fs.readFileSync(sentinel), sentinelBytes);
    }
    assert.deepEqual(fs.readdirSync(path.join(root, "docs/myrmidon/changes")).sort(), ["a-2.md", "a.md"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
