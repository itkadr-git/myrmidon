import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { commitWithTaskSubjectExists } from "./cut-rc.mjs";

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function repo(t, subject) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cut-subject-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.com");
  git(root, "commit", "-q", "--allow-empty", "-m", subject);
  return root;
}

function snapshot(root) {
  return [git(root, "symbolic-ref", "HEAD"), git(root, "rev-parse", "HEAD"),
    git(root, "for-each-ref", "--format=%(refname) %(objectname)")];
}

function check(root, taskId, ref, expected) {
  const before = snapshot(root);
  assert.strictEqual(commitWithTaskSubjectExists(root, taskId, ref), expected);
  assert.deepStrictEqual(snapshot(root), before);
}

for (const [subject, expected] of [
  ["OPE-100: delivery", true],
  ["delivery OPE-100", true],
  ["delivery (OPE-100)", true],
  ["delivery ope-100", true],
  ["delivery OPE-10084", false],
  ["delivery XOPE-100", false],
  ["delivery OPE-100x", false],
  ["delivery OPE-100-extra", false],
]) {
  test(`subject boundary: ${subject}`, (t) => {
    const root = repo(t, subject);
    check(root, "OPE-100", "main", expected);
  });
}

test("only commits reachable from the requested branch count", (t) => {
  const root = repo(t, "unrelated delivery");
  git(root, "switch", "-q", "-c", "side");
  git(root, "commit", "-q", "--allow-empty", "-m", "OPE-100: side delivery");
  git(root, "switch", "-q", "main");
  check(root, "OPE-100", "main", false);
  check(root, "OPE-100", "side", true);
});

test("empty task and nonexistent ref return false without changing refs", (t) => {
  const root = repo(t, "OPE-100: delivery");
  check(root, "", "main", false);
  check(root, "OPE-100", "missing-branch", false);
});
