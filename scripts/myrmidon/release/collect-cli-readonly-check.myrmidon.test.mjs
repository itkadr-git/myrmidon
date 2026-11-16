import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("./collect-fragments.mjs", import.meta.url));
const en = "docs/myrmidon/CHANGELOG.md";
const ru = "docs/myrmidon/CHANGELOG.ru.md";
const fragment = "docs/myrmidon/changes/invalid.md";
const badFragment = "## changlog-en\n\n- typo in section name\n";
const validEn = "## Unreleased\n\n## 1.7.0\n\n- English note.\n";
const validRu = "## Без выпуска\n\n## 1.7.0\n\n- Русская запись.\n";

function write(root, name, contents) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function snapshot(root, prefix = "") {
  return fs.readdirSync(path.join(root, prefix), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const name = path.join(prefix, entry.name);
      if (entry.isDirectory()) return [[name, "directory"], ...snapshot(root, name)];
      return [[name, fs.readFileSync(path.join(root, name)).toString("base64")]];
    });
}

function run(root, mode) {
  const result = spawnSync(process.execPath, [script, mode, "--root", root, "--version", "1.7.0"], {
    encoding: "utf8", cwd: root, env: { HOME: root, TMPDIR: root, PATH: "" },
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "collect-readonly-"));
  try {
    write(root, fragment, badFragment);
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("CLI check ignores invalid fragments and is read-only on success, failure, and repeat", () => fixture((root) => {
  write(root, en, validEn);
  write(root, ru, validRu);
  const before = snapshot(root);
  const success = "release changelog check ok: 1.7.0 has its section in both changelogs\n";
  let result = run(root, "--check");
  assert.equal(result.status, 0);
  assert.equal(result.stdout, success);
  assert.equal(result.stderr, "");
  assert.deepEqual(snapshot(root), before);

  write(root, ru, "## Без выпуска\n\n## 1.7.0\n");
  const invalid = snapshot(root);
  result = run(root, "--check");
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, 'collect-fragments: docs/myrmidon/CHANGELOG.ru.md: "## 1.7.0" is empty — a release without notes is a defect\n');
  assert.deepEqual(snapshot(root), invalid);

  write(root, ru, validRu);
  for (let i = 0; i < 2; i += 1) {
    result = run(root, "--check");
    assert.equal(result.status, 0);
    assert.equal(result.stdout, success);
    assert.equal(result.stderr, "");
    assert.deepEqual(snapshot(root), before);
  }
}));

test("CLI merge normalizes both changelogs without consuming invalid fragments and is idempotent", () => fixture((root) => {
  write(root, en, "## Unreleased\n\n## 1.7.0\n\n- First.\n\n## 1.7.0\n\n- Second.\n");
  write(root, ru, "## Без выпуска\n\n## 1.7.0\n\n- Первый.\n\n## 1.7.0\n\n- Второй.\n");
  let result = run(root, "--merge-sections");
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, 'update docs/myrmidon/CHANGELOG.md\nupdate docs/myrmidon/CHANGELOG.ru.md\nmerged repeated "## 1.7.0" headings in 2 document(s)\n');
  assert.equal(fs.readFileSync(path.join(root, en), "utf8"), "## Unreleased\n\n## 1.7.0\n\n- First.\n\n- Second.\n");
  assert.equal(fs.readFileSync(path.join(root, ru), "utf8"), "## Без выпуска\n\n## 1.7.0\n\n- Первый.\n\n- Второй.\n");
  assert.equal(fs.readFileSync(path.join(root, fragment), "utf8"), badFragment);
  const after = snapshot(root);
  result = run(root, "--merge-sections");
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, 'merged repeated "## 1.7.0" headings in 0 document(s)\n');
  assert.deepEqual(snapshot(root), after);
}));
