import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { normalizeGitBases } from "../../../docker/bot-runtime/botd/lib/normalize-git-bases.js";

const hasGit = spawnSync("git", ["--version"]).status === 0;
const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

let tmp;

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...GIT_ENV, HOME: tmp } });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A bare base with one commit; returns the commit sha. */
function makeBase(owner, repo, label, branch = "main") {
  const bare = path.join(tmp, "git-base", owner, `${repo}.git`);
  fs.mkdirSync(bare, { recursive: true });
  git(bare, "init", "--bare", "--quiet", "-b", "main");
  const work = fs.mkdtempSync(path.join(tmp, "work-"));
  git(work, "init", "--quiet", "-b", "main");
  fs.writeFileSync(path.join(work, "f.txt"), `${label}\n`);
  git(work, "add", ".");
  git(work, "commit", "--quiet", "-m", label);
  const sha = git(work, "rev-parse", "HEAD");
  git(work, "push", "--quiet", bare, `main:refs/heads/${branch}`);
  fs.rmSync(work, { recursive: true, force: true });
  return { bare, sha };
}

function newRoot() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "botd-normalize-"));
  return path.join(tmp, "git-base");
}

describe("botd normalize-git-bases: merge legacy mixed-case directories", { skip: !hasGit && "git missing" }, () => {
  it("renames a base to lower-case when no duplicate exists", () => {
    const root = newRoot();
    const { bare, sha } = makeBase("Acme", "Widgets", "one");
    const result = normalizeGitBases(root);
    assert.deepEqual(result, [{ source: bare, target: path.join(root, "acme", "widgets.git") }]);
    assert.equal(git(path.join(root, "acme", "widgets.git"), "rev-parse", "refs/heads/main"), sha);
    assert.equal(fs.existsSync(bare), false);
    assert.equal(fs.existsSync(path.join(root, "Acme")), false, "empty mixed-case owner removed");
  });

  it("merges a duplicate into the canonical base only after objects are verified", () => {
    const root = newRoot();
    const lower = makeBase("acme", "widgets", "shared");
    const upper = makeBase("Acme", "Widgets", "extra", "feature-x");
    const legacy = upper.bare;
    const target = path.join(root, "acme", "widgets.git");
    const result = normalizeGitBases(root);
    assert.deepEqual(result, [{ source: legacy, target }]);
    const refs = git(target, "for-each-ref", "--format=%(refname)");
    assert.match(refs, /refs\/heads\/main/);
    assert.match(refs, /refs\/heads\/feature-x/, "legacy-only ref survives");
    assert.equal(git(target, "cat-file", "-t", upper.sha), "commit");
    assert.equal(git(target, "cat-file", "-t", lower.sha), "commit");
    assert.equal(fs.existsSync(legacy), false);
    assert.equal(fs.existsSync(path.join(root, "Acme")), false);
  });

  it("defers a base with linked worktrees and removes nothing", () => {
    const root = newRoot();
    const { bare, sha } = makeBase("Acme", "Linked", "one");
    const worktree = path.join(tmp, "wt-linked");
    git(bare, "worktree", "add", "--quiet", "--detach", worktree, sha);
    const result = normalizeGitBases(root);
    assert.deepEqual(result, []);
    assert.equal(fs.existsSync(bare), true, "source kept");
    assert.equal(fs.existsSync(path.join(root, "acme", "linked.git")), false);
    git(bare, "worktree", "remove", "--force", worktree);
  });

  it("defers a base with a conflicting ref and keeps both copies", () => {
    const root = newRoot();
    makeBase("acme", "conflict", "from-canonical");
    const upper = makeBase("Acme", "Conflict", "from-legacy");
    const legacy = upper.bare;
    const result = normalizeGitBases(root);
    assert.deepEqual(result, [], "same ref, different sha: deferred");
    assert.equal(fs.existsSync(legacy), true, "source kept on failure");
    assert.equal(fs.existsSync(path.join(root, "acme", "conflict.git")), true);
    // Recoverable: once the conflicting ref is dropped the next pass merges.
    git(legacy, "update-ref", "-d", "refs/heads/main");
    const retried = normalizeGitBases(root);
    assert.equal(retried.length, 1);
    assert.equal(fs.existsSync(legacy), false);
  });

  it("is idempotent: a normalized tree is left unchanged", () => {
    const root = newRoot();
    makeBase("acme", "widgets", "one");
    assert.equal(normalizeGitBases(root).length, 0);
    assert.equal(normalizeGitBases(root).length, 0);
  });
});
