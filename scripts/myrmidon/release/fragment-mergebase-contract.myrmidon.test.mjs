import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./fragments-from-diff.mjs", import.meta.url));
const gitBin = fs.existsSync("/usr/bin/git") ? "/usr/bin/git" : "git";
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(os.homedir(), ".cache", "fragment-mergebase-tests");
const env = {
  PATH: "/usr/bin:/bin",
  HOME: scratch,
  TMPDIR: scratch,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};
const docs = ["docs/myrmidon/CHANGELOG.md", "docs/myrmidon/CHANGELOG.ru.md"];
const base = ["# Changelog\n\n## Unreleased\n\n## 1.0.0\n", "# Changelog\n\n## Без выпуска\n\n## 1.0.0\n"];
const feature = ["### Feature (F-1)\n\nFeature content.\n\n", "### Функция (F-1)\n\nСодержание функции.\n\n"];
const main = ["### Main (M-1)\n\nMain content.\n\n", "### Основная (M-1)\n\nСодержание основной.\n\n"];

function command(cwd, bin, args) {
  const result = spawnSync(bin, args, { cwd, env, encoding: "utf8", timeout: 10000 });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, `${bin} ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}
function git(cwd, ...args) { return command(cwd, gitBin, args); }
function writeDocs(dir, entries) {
  docs.forEach((doc, i) => {
    const file = path.join(dir, doc);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, base[i].replace("## 1.0.0", `${entries[i] || ""}## 1.0.0`));
  });
}
function commit(dir, message) {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
}
function scenario(diverged) {
  fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, "mergebase-"));
  try {
    git(dir, "init", "-q", "-b", "main");
    writeDocs(dir, ["", ""]);
    commit(dir, "base");
    git(dir, "checkout", "-q", "-b", "feature");
    writeDocs(dir, feature);
    commit(dir, "feature");
    if (diverged) {
      git(dir, "checkout", "-q", "main");
      writeDocs(dir, main);
      commit(dir, "main");
      git(dir, "checkout", "-q", "feature");
    }
    const before = docs.map((doc) => fs.readFileSync(path.join(dir, doc)));
    assert.equal(git(dir, "status", "--porcelain"), "");
    command(dir, process.execPath, [script, "--root", dir, "--base", "main", "--head", "HEAD", "--slug", "feature"]);
    const fragment = fs.readFileSync(path.join(dir, "docs/myrmidon/changes/feature.md"), "utf8");
    assert.equal(fragment, `## changelog-en\n\n${feature[0]}## changelog-ru\n\n${feature[1].trimEnd()}\n`);
    for (const foreign of main) assert.ok(!fragment.includes(foreign));
    docs.forEach((doc, i) => assert.deepEqual(fs.readFileSync(path.join(dir, doc)), before[i]));
    assert.equal(git(dir, "status", "--porcelain", "--untracked-files=all"), "?? docs/myrmidon/changes/feature.md\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("converts only feature changes from merge-base when main diverges", () => scenario(true));
test("converts feature changes in a linear history", () => scenario(false));
