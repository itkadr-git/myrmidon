import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { check, mergeBase } from "./change-fragments-gate.mjs";

function git(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

function makeSandbox() {
  const scratch = process.env.TMPDIR ?? os.tmpdir();
  const dir = fs.mkdtempSync(path.join(scratch, "fragment-unrelated-history-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "agent-a@example.com"]);
  git(dir, ["config", "user.name", "agent-a"]);
  fs.mkdirSync(path.join(dir, "docs/myrmidon"), { recursive: true });
  fs.mkdirSync(path.join(dir, "server"), { recursive: true });
  fs.writeFileSync(path.join(dir, "docs/myrmidon/CHANGELOG.md"), "# changelog\n");
  fs.writeFileSync(path.join(dir, "server/index.ts"), "// code\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-qm", "base"]);
  const base = git(dir, ["rev-parse", "HEAD"]);

  function orphanCommit(files, message) {
    git(dir, ["checkout", "-q", "--orphan", message]);
    for (const entry of fs.readdirSync(dir)) {
      if (entry !== ".git") fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
    }
    for (const [relativePath, contents] of Object.entries(files)) {
      const target = path.join(dir, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
    }
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", message]);
    return git(dir, ["rev-parse", "HEAD"]);
  }

  const docHead = orphanCommit(
    { "docs/myrmidon/CHANGELOG.md": "# orphan changelog\n", "server/index.ts": "// code\n" },
    "orphan-doc",
  );
  git(dir, ["checkout", "-q", "main"]);
  const codeHead = orphanCommit(
    { "docs/myrmidon/CHANGELOG.md": "# changelog\n", "server/index.ts": "// orphan code\n" },
    "orphan-code",
  );
  git(dir, ["checkout", "-q", "main"]);

  return { dir, base, docHead, codeHead };
}

function withSandbox(run) {
  const sandbox = makeSandbox();
  try {
    return run(sandbox);
  } finally {
    fs.rmSync(sandbox.dir, { recursive: true, force: true });
  }
}

function eventFile(dir, base, head) {
  const file = path.join(dir, `event-${head}.json`);
  fs.writeFileSync(file, JSON.stringify({ pull_request: { base: { sha: base }, head: { sha: head } } }));
  return file;
}

test("pull_request event falls back to the given base for an unrelated doc history", () => {
  withSandbox(({ dir, base, docHead }) => {
    assert.equal(mergeBase(dir, base, docHead), null);
    const result = check({ root: dir, eventFile: eventFile(dir, base, docHead) });

    assert.equal(result.skipped, false);
    assert.deepEqual(result.range, { base, head: docHead });
    assert.deepEqual(result.changes, [{ status: "M", file: "docs/myrmidon/CHANGELOG.md" }]);
    assert.equal(result.ok, false);
    assert.deepEqual(result.violations, [{ status: "M", file: "docs/myrmidon/CHANGELOG.md" }]);
  });
});

test("pull_request event falls back to the given base for an unrelated code history", () => {
  withSandbox(({ dir, base, codeHead }) => {
    assert.equal(mergeBase(dir, base, codeHead), null);
    const result = check({ root: dir, eventFile: eventFile(dir, base, codeHead) });

    assert.equal(result.skipped, false);
    assert.deepEqual(result.range, { base, head: codeHead });
    assert.deepEqual(result.changes, [{ status: "M", file: "server/index.ts" }]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.violations, []);
  });
});

test("check propagates an unknown revision error instead of skipping or succeeding", () => {
  withSandbox(({ dir, base }) => {
    assert.throws(
      () => check({ root: dir, base: "definitely-not-a-revision", head: base }),
      /fatal: bad revision|unknown revision|ambiguous argument/i,
    );
  });
});
