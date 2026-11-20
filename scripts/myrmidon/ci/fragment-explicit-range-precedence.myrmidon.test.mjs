import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { check } from "./change-fragments-gate.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fragment-range-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  const commit = (file, contents) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
    git("add", file);
    git("commit", "-qm", "fixture");
    return git("rev-parse", "HEAD");
  };
  const base = commit("docs/myrmidon/CHANGELOG.md", "base\n");
  const explicitHead = commit("docs/myrmidon/CHANGELOG.md", "explicit violation\n");
  const eventHead = commit("server/index.js", "event change\n");
  const eventFile = path.join(root, "event.json");
  fs.writeFileSync(eventFile, JSON.stringify({ pull_request: {
    base: { sha: explicitHead }, head: { sha: eventHead },
  } }));
  return { root, base, explicitHead, eventHead, eventFile };
}

function assertResult(result, range, eventName, violations) {
  assert.equal(result.skipped, false);
  assert.deepEqual(result.range, range);
  assert.equal(result.eventName, eventName);
  assert.deepEqual(result.violations, violations);
  assert.equal(result.ok, violations.length === 0);
}

const violation = [{ status: "M", file: "docs/myrmidon/CHANGELOG.md" }];

test("complete explicit range takes precedence over a different PR event range", (t) => {
  const f = fixture(t);
  const result = check({ root: f.root, base: f.base, head: f.explicitHead, eventFile: f.eventFile });
  assertResult(result, { base: f.base, head: f.explicitHead }, null, violation);
});

test("complete explicit range does not read a missing event file", (t) => {
  const f = fixture(t);
  const result = check({ root: f.root, base: f.base, head: f.explicitHead, eventFile: path.join(f.root, "missing.json") });
  assertResult(result, { base: f.base, head: f.explicitHead }, null, violation);
});

test("explicit base without head falls back to the full PR event range", (t) => {
  const f = fixture(t);
  const result = check({ root: f.root, base: f.base, eventFile: f.eventFile });
  assertResult(result, { base: f.explicitHead, head: f.eventHead }, "pull_request", []);
});

test("explicit head without base falls back to the full PR event range", (t) => {
  const f = fixture(t);
  const result = check({ root: f.root, head: f.base, eventFile: f.eventFile });
  assertResult(result, { base: f.explicitHead, head: f.eventHead }, "pull_request", []);
});
