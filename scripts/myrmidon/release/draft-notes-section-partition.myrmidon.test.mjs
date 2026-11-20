import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("../../draft-stable-notes.sh", import.meta.url).pathname;
const path = process.env.PATH.split(":").filter((part) => !part.includes("paperclip-github-runtime")).join(":");

function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, "-c", "user.name=notes-test", "-c", "user.email=notes@example.invalid", ...args], {
    encoding: "utf8", env: { ...process.env, PATH: path }, stdio: "pipe",
  });
}

function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), "notes-partition-"));
  try {
    git(dir, "init", "-q", "-b", "master");
    git(dir, "commit", "--allow-empty", "-m", "baseline");
    git(dir, "tag", "v2026.100.0");
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf called > '${join(dir, "gh-called")}'\nexit 1\n`, { mode: 0o755 });
    fn({ dir, bin });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function commit(dir, subject, body) {
  git(dir, "commit", "--allow-empty", "-m", subject, ...(body ? ["-m", body] : []));
}

function draft(f, out = join(f.dir, "notes.md")) {
  git(f.dir, "tag", "-f", "beta/v2026.101.0-beta.0");
  execFileSync("bash", [script, "2026.101.0-beta.0", "--repo-dir", f.dir, "--out", out], {
    env: { ...process.env, BASH_ENV: "", PATH: `${f.bin}:${path}`, DRAFT_NOTES_SKIP_PR_ENRICHMENT: "1" }, stdio: "pipe",
  });
  assert.equal(existsSync(join(f.dir, "gh-called")), false, "gh must not be invoked");
  return readFileSync(out, "utf8");
}

function sections(body) {
  const start = body.indexOf("\n## ");
  return start === -1 ? "" : body.slice(start + 1);
}

function expectSections(f, expected) {
  assert.equal(sections(draft(f)), expected);
}

test("partitions interleaved subjects exactly once in reverse order", () => fixture((f) => {
  for (const subject of ["feat: first", "fix: first fix", "chore: first chore", "feat(api): scoped", "docs: guide", "fix(ui): scoped fix", "feat: last"]) commit(f.dir, subject);
  expectSections(f, "## Features\n\n- feat: last\n- feat(api): scoped\n- feat: first\n\n## Fixes\n\n- fix(ui): scoped fix\n- fix: first fix\n\n## Other changes\n\n- docs: guide\n- chore: first chore\n\n");
}));

test("classifies scoped and unscoped breaking features", () => fixture((f) => {
  commit(f.dir, "feat!: breaking");
  commit(f.dir, "feat(api)!: scoped breaking");
  expectSections(f, "## Features\n\n- feat(api)!: scoped breaking\n- feat!: breaking\n\n");
}));

test("classifies scoped and unscoped breaking fixes", () => fixture((f) => {
  commit(f.dir, "fix!: breaking repair");
  commit(f.dir, "fix(api)!: scoped breaking repair");
  expectSections(f, "## Fixes\n\n- fix(api)!: scoped breaking repair\n- fix!: breaking repair\n\n");
}));

test("places near misses in Other changes", () => fixture((f) => {
  for (const subject of ["feature: similar", "Fix: uppercase", "feat:no space", "fix:no space"]) commit(f.dir, subject);
  expectSections(f, "## Other changes\n\n- fix:no space\n- feat:no space\n- Fix: uppercase\n- feature: similar\n\n");
}));

test("omits empty sections for only other changes", () => fixture((f) => {
  commit(f.dir, "docs: only documentation");
  expectSections(f, "## Other changes\n\n- docs: only documentation\n\n");
}));

test("does not include merge subjects while retaining merged commits", () => fixture((f) => {
  git(f.dir, "checkout", "-q", "-b", "topic");
  commit(f.dir, "feat: topic");
  git(f.dir, "checkout", "-q", "master");
  git(f.dir, "merge", "--no-ff", "-m", "Merge topic", "topic");
  expectSections(f, "## Features\n\n- feat: topic\n\n");
}));

test("ignores multiline bodies even when they resemble subjects", () => fixture((f) => {
  commit(f.dir, "fix: actual subject", "feat: fake body subject\n\nchore: another body line");
  expectSections(f, "## Fixes\n\n- fix: actual subject\n\n");
}));

test("overwrites explicit output and repeats byte-for-byte without enrichment", () => fixture((f) => {
  commit(f.dir, "feat: PR-backed (#77)");
  const out = join(f.dir, "notes.md");
  writeFileSync(out, "stale bytes");
  const first = draft(f, out);
  assert.equal(sections(first), "## Features\n\n- feat: PR-backed (#77)\n\n");
  writeFileSync(out, `${first}stale appended bytes`);
  assert.equal(draft(f, out), first);
}));
