import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./fragments-from-diff.mjs", import.meta.url));
const git = fs.existsSync("/usr/bin/git") ? "/usr/bin/git" : "git";
const documents = ["CHANGELOG.md", "CHANGELOG.ru.md", "DIVERGENCE.md", "SETTINGS.md", "SETTINGS.ru.md"];
const en = "# Changelog\n\n## Unreleased\n\n## 1.0.0\n\n- Shipped.\n";
const ru = "# Changelog\n\n## \u0411\u0435\u0437 \u0432\u044b\u043f\u0443\u0441\u043a\u0430\n\n## 1.0.0\n\n- Shipped.\n";
const enEntry = "### Feature (F-1)\n\nNew behavior.\n\n";
const ruEntry = "### \u0424\u0443\u043d\u043a\u0446\u0438\u044f (F-1)\n\n\u041d\u043e\u0432\u043e\u0435 \u043f\u043e\u0432\u0435\u0434\u0435\u043d\u0438\u0435.\n\n";
const expected = Buffer.from(`## changelog-en\n\n${enEntry}## changelog-ru\n\n${ruEntry.trimEnd()}\n`);
const sentinel = Buffer.from("existing target sentinel\n");
const neighbor = Buffer.from("neighbor fragment sentinel\n");

function withFixture(callback) {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(os.homedir(), ".myrmidon-scratch");
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "fragment-force-"));
  const env = {
    PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root, FRAGMENT_TMPDIR: root,
    GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com",
  };
  const runGit = (...args) => execFileSync(git, args, { cwd: root, env, timeout: 10000, stdio: "pipe" });
  const write = (rel, content) => {
    const file = path.join(root, "docs/myrmidon", rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  try {
    runGit("init", "-q", "-b", "main");
    write(documents[0], en);
    write(documents[1], ru);
    for (const doc of documents.slice(2)) write(doc, "# Registry\n\n## Existing\n\nText.\n");
    runGit("add", ".");
    runGit("commit", "-q", "-m", "base");
    runGit("checkout", "-q", "-b", "feature");
    write(documents[0], en.replace("## 1.0.0", `${enEntry}## 1.0.0`));
    write(documents[1], ru.replace("## 1.0.0", `${ruEntry}## 1.0.0`));
    runGit("add", ".");
    runGit("commit", "-q", "-m", "bilingual entry");
    write("changes/target.md", sentinel);
    write("changes/neighbor.md", neighbor);
    const read = (rel) => fs.readFileSync(path.join(root, "docs/myrmidon", rel));
    const beforeDocs = documents.map(read);
    const invoke = (...args) => {
      const result = spawnSync(process.execPath, [script, "--root", root, "--base", "main", "--slug", "target", ...args], { cwd: root, env, timeout: 10000, encoding: "utf8" });
      assert.ifError(result.error);
      return result;
    };
    const unchanged = () => {
      assert.deepEqual(read("changes/neighbor.md"), neighbor);
      assert.deepEqual(documents.map(read), beforeDocs);
    };
    callback({ invoke, read, unchanged });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("existing fragment requires explicit force and preserves unrelated bytes", () => {
  withFixture(({ invoke, read, unchanged }) => {
    const denied = invoke();
    assert.equal(denied.status, 2, denied.stderr);
    assert.deepEqual(read("changes/target.md"), sentinel);
    unchanged();
    const forced = invoke("--force");
    assert.equal(forced.status, 0, forced.stderr);
    assert.deepEqual(read("changes/target.md"), expected);
    unchanged();
  });
});

test("dry-run with force does not write target or documents even with revert", () => {
  withFixture(({ invoke, read, unchanged }) => {
    const result = invoke("--dry-run", "--force", "--revert");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(read("changes/target.md"), sentinel);
    unchanged();
  });
});
