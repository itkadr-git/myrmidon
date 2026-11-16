import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseFragment } from "./collect-fragments.mjs";

const script = fileURLToPath(new URL("./fragments-from-diff.mjs", import.meta.url));
const gitBin = fs.existsSync("/usr/bin/git") ? "/usr/bin/git" : "git";
const docs = ["CHANGELOG.md", "CHANGELOG.ru.md", "DIVERGENCE.md", "SETTINGS.md", "SETTINGS.ru.md"].map((name) => `docs/myrmidon/${name}`);
const fragmentDir = "docs/myrmidon/changes";
const changelog = "# Changelog\n\n## Unreleased\n\n### Old\n\n- Old.\n\n## 1.0.0\n\n- Shipped.\n";
const settings = "# Settings\n\nIntro line.\n\n## Operations\n\nExisting text.\n";
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(os.homedir(), ".cache", "myrmidon-test-scratch");

for (const revert of [false, true]) {
  test(`mixed unsupported diff is atomic${revert ? " with --revert" : " without --revert"}`, () => {
    fs.mkdirSync(scratch, { recursive: true });
    const root = fs.mkdtempSync(path.join(scratch, "fragment-atomic-"));
    const env = {
      PATH: `/usr/bin:/bin`, HOME: root, TMPDIR: root, FRAGMENT_TMPDIR: root,
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com",
    };
    const exec = (cmd, args) => {
      const result = spawnSync(cmd, args, { cwd: root, env, encoding: "utf8", timeout: 10000 });
      assert.ifError(result.error);
      return result;
    };
    const git = (...args) => {
      const result = exec(gitBin, args);
      assert.equal(result.status, 0, result.stderr);
    };
    const write = (rel, content) => {
      const file = path.join(root, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    };
    const read = (rel) => fs.readFileSync(path.join(root, rel));
    try {
      git("init", "-q", "-b", "main");
      write(docs[0], changelog);
      write(docs[1], changelog.replace("Unreleased", "Без выпуска"));
      for (const rel of docs.slice(2)) write(rel, settings);
      write(`${fragmentDir}/other.md`, "# An existing unrelated fragment\n\nKeep me byte-for-byte.\n");
      git("add", "-A");
      git("commit", "-q", "-m", "base");
      git("checkout", "-q", "-b", "feature");
      write(docs[0], changelog.replace("\n## 1.0.0", "\n### New feature\n\n- New entry.\n\n## 1.0.0"));
      write(docs[1], changelog.replace("Unreleased", "Без выпуска").replace("\n## 1.0.0", "\n### Новая функция\n\n- Новая запись.\n\n## 1.0.0"));
      write(docs[3], settings.replace("Intro line.", "Reworded introduction."));
      git("add", "-A");
      git("commit", "-q", "-m", "mixed edits");
      const before = new Map([...docs, `${fragmentDir}/other.md`].map((rel) => [rel, read(rel)]));
      const args = [script, "--root", root, "--base", "main", "--slug", "mixed-case", ...(revert ? ["--revert"] : [])];
      const bad = exec(process.execPath, args);
      assert.equal(bad.status, 1, bad.stderr);
      assert.equal(bad.stdout, 'unsupported: docs/myrmidon/SETTINGS.md: base line 3 -> head line 3: edits or deletes existing text (1 line(s) removed: "Intro line.")\nnothing written: the edits above need a human (or the format needs to grow).\n');
      assert.equal(bad.stderr, "");
      for (const [rel, bytes] of before) assert.deepEqual(read(rel), bytes, rel);
      assert.deepEqual(fs.readdirSync(path.join(root, fragmentDir)), ["other.md"]);

      write(docs[3], settings);
      git("add", docs[3]);
      git("commit", "-q", "-m", "remove unsupported edit");
      const good = exec(process.execPath, args);
      assert.equal(good.status, 0, `${good.stdout}\n${good.stderr}`);
      assert.equal(good.stderr, "");
      assert.deepEqual(fs.readdirSync(path.join(root, fragmentDir)).sort(), ["mixed-case.md", "other.md"]);
      assert.deepEqual(read(`${fragmentDir}/other.md`), before.get(`${fragmentDir}/other.md`));
      const parsed = parseFragment(read(`${fragmentDir}/mixed-case.md`).toString("utf8"));
      assert.match(parsed.sections["changelog-en"], /New entry\./);
      assert.match(parsed.sections["changelog-ru"], /Новая запись\./);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
