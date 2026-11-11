import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { check, judge, mergeBase } from "./change-fragments-gate.mjs";

// CHANGE-FRAGMENTS: self-test of the CI gate. The gate's own unit cases run
// against judge() directly; the end-to-end cases build a sandbox git
// repository with a base commit and a PR-range commit and run the script
// against it. No repository file of the real checkout is touched.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "change-fragments-gate.mjs");

function git(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

/** A git repo with one base commit; apply() adds commits on top. */
function gitSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "change-fragments-gate-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "agent-a@example.com"]);
  git(dir, ["config", "user.name", "agent-a"]);
  fs.mkdirSync(path.join(dir, "docs/myrmidon/changes"), { recursive: true });
  fs.mkdirSync(path.join(dir, "server"), { recursive: true });
  fs.writeFileSync(path.join(dir, "docs/myrmidon/CHANGELOG.md"), "# changelog\n");
  fs.writeFileSync(path.join(dir, "server/index.ts"), "// code\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-qm", "base"]);
  const base = git(dir, ["rev-parse", "HEAD"]);
  return {
    dir,
    base,
    apply(files) {
      for (const [rel, text] of Object.entries(files)) {
        const target = path.join(dir, rel);
        if (text === null) fs.rmSync(target);
        else {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, text);
        }
      }
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-qm", "change"]);
      return git(dir, ["rev-parse", "HEAD"]);
    },
  };
}

describe("judge", () => {
  it("a hand edit of CHANGELOG.md is a violation", () => {
    const v = judge([{ status: "M", file: "docs/myrmidon/CHANGELOG.md" }]);
    assert.equal(v.ok, false);
    assert.deepEqual(v.violations.map((x) => x.file), ["docs/myrmidon/CHANGELOG.md"]);
  });

  it("all five shared documents are protected", () => {
    for (const file of [
      "docs/myrmidon/CHANGELOG.md",
      "docs/myrmidon/CHANGELOG.ru.md",
      "docs/myrmidon/DIVERGENCE.md",
      "docs/myrmidon/SETTINGS.md",
      "docs/myrmidon/SETTINGS.ru.md",
    ]) {
      assert.equal(judge([{ status: "M", file }]).ok, false, file);
    }
  });

  it("a new fragment plus code is fine", () => {
    const v = judge([
      { status: "A", file: "docs/myrmidon/changes/feat-a.md" },
      { status: "M", file: "server/src/index.ts" },
    ]);
    assert.equal(v.ok, true);
  });

  it("a code change without any fragment is fine — fragments are not mandatory", () => {
    assert.equal(judge([{ status: "M", file: "server/src/index.ts" }]).ok, true);
  });

  it("the release cut (fragment deletions plus shared-doc edits) is fine", () => {
    const v = judge([
      { status: "D", file: "docs/myrmidon/changes/feat-a.md" },
      { status: "M", file: "docs/myrmidon/CHANGELOG.md" },
      { status: "M", file: "docs/myrmidon/DIVERGENCE.md" },
    ]);
    assert.equal(v.ok, true);
    assert.equal(v.releaseCut, true);
  });

  it("adding a brand-new shared document is refused even on a release cut", () => {
    const v = judge([
      { status: "D", file: "docs/myrmidon/changes/feat-a.md" },
      { status: "A", file: "docs/myrmidon/CHANGELOG.md" },
    ]);
    assert.equal(v.ok, false);
  });

  it("other docs are not protected", () => {
    assert.equal(judge([{ status: "M", file: "docs/myrmidon/deploy.md" }]).ok, true);
  });
});

describe("check against a git sandbox", () => {
  it("green on a fragment-only PR range", () => {
    const repo = gitSandbox();
    const head = repo.apply({ "docs/myrmidon/changes/feat-a.md": "## changelog-en\n\n### A\n" });
    const result = check({ root: repo.dir, base: repo.base, head });
    assert.equal(result.skipped, false);
    assert.equal(result.ok, true);
  });

  it("red on a hand-edited CHANGELOG in the PR range", () => {
    const repo = gitSandbox();
    const head = repo.apply({ "docs/myrmidon/CHANGELOG.md": "# changelog\n\n## Unreleased\n\n- hand edit\n" });
    const result = check({ root: repo.dir, base: repo.base, head });
    assert.equal(result.ok, false);
    assert.deepEqual(result.violations.map((x) => x.file), ["docs/myrmidon/CHANGELOG.md"]);
  });

  it("reads base/head from a pull_request event file", () => {
    const repo = gitSandbox();
    const head = repo.apply({ "server/index.ts": "// code v2\n" });
    const eventFile = path.join(repo.dir, "event.json");
    fs.writeFileSync(
      eventFile,
      JSON.stringify({ pull_request: { base: { sha: repo.base }, head: { sha: head } } }),
    );
    const result = check({ root: repo.dir, eventFile });
    assert.equal(result.eventName, "pull_request");
    assert.equal(result.ok, true);
  });

  // OPE-11991: base.sha in a pull_request event is the tip of the base branch,
  // not the merge point. A docs-only PR must not fail because commits that
  // merged to main after it branched touched the shared registry documents.
  it("event base.sha at the tip of main, ahead of the merge point, still judges only the PR diff", () => {
    const repo = gitSandbox();
    // The PR's own commit: fragment-only, clean.
    const fork = repo.apply({ "docs/myrmidon/changes/feat-a.md": "## changelog-en\n\n### A\n" });
    // Meanwhile main moves on with a hand edit of a shared document.
    git(repo.dir, ["checkout", "-q", "main"]);
    git(repo.dir, ["reset", "-q", "--hard", repo.base]);
    const mainTip = repo.apply({ "docs/myrmidon/CHANGELOG.md": "# changelog\n\n- merged to main\n" });
    // The event reports base.sha = tip of main; the PR head is `fork`.
    const eventFile = path.join(repo.dir, "event.json");
    fs.writeFileSync(
      eventFile,
      JSON.stringify({ pull_request: { base: { sha: mainTip }, head: { sha: fork } } }),
    );
    const result = check({ root: repo.dir, eventFile });
    assert.equal(result.eventName, "pull_request");
    // The judged range is merge-base(mainTip, fork)..fork, not mainTip..fork.
    assert.equal(result.range.base, repo.base);
    assert.equal(result.range.head, fork);
    assert.equal(result.ok, true, JSON.stringify(result.violations));
  });

  it("a hand edit inside the PR's own diff still fails even with a moving base", () => {
    const repo = gitSandbox();
    const fork = repo.apply({ "docs/myrmidon/CHANGELOG.md": "# changelog\n\n- hand edit\n" });
    git(repo.dir, ["checkout", "-q", "main"]);
    git(repo.dir, ["reset", "-q", "--hard", repo.base]);
    const mainTip = repo.apply({ "server/index.ts": "// code v2\n" });
    const eventFile = path.join(repo.dir, "event.json");
    fs.writeFileSync(
      eventFile,
      JSON.stringify({ pull_request: { base: { sha: mainTip }, head: { sha: fork } } }),
    );
    const result = check({ root: repo.dir, eventFile });
    assert.equal(result.ok, false);
    assert.deepEqual(result.violations.map((x) => x.file), ["docs/myrmidon/CHANGELOG.md"]);
  });

  it("mergeBase returns the fork point; null for unknown revs", () => {
    const repo = gitSandbox();
    const fork = repo.apply({ "server/index.ts": "// code v2\n" });
    assert.equal(mergeBase(repo.dir, repo.base, fork), repo.base);
    assert.equal(mergeBase(repo.dir, "definitely-not-a-sha", fork), null);
  });

  it("a non-PR event file without explicit range is skipped", () => {
    const repo = gitSandbox();
    const eventFile = path.join(repo.dir, "event.json");
    fs.writeFileSync(eventFile, JSON.stringify({ push: { before: "x" } }));
    assert.equal(check({ root: repo.dir, eventFile }).skipped, true);
    assert.equal(check({ root: repo.dir }).skipped, true);
  });
});

describe("CLI", () => {
  it("exit 1 with the hint on a hand-edited shared document", () => {
    const repo = gitSandbox();
    const head = repo.apply({ "docs/myrmidon/DIVERGENCE.md": "# registry\n\n| hand | row |\n" });
    const res = spawnSync(
      "node",
      [SCRIPT, "--root", repo.dir, "--base", repo.base, "--head", head],
      { encoding: "utf8" },
    );
    assert.equal(res.status, 1);
    assert.match(res.stderr, /shared registry documents edited by hand/);
    assert.match(res.stderr, /docs.myrmidon.changes.README\.md/);
  });

  it("exit 0 and a skip note without any range", () => {
    const res = spawnSync("node", [SCRIPT, "--root", os.tmpdir()], { encoding: "utf8" });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /skipped/);
  });
});
