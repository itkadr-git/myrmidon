import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { prepareNpmReadme } from "../prepare-npm-readme.mjs";

const script = fileURLToPath(new URL("../prepare-npm-readme.mjs", import.meta.url));
const ref = "abc123";
const base = "https://raw.githubusercontent.com/paperclipai/paperclip/abc123/doc/assets/";

function fixture(t) {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(homedir(), ".cache");
  const dir = mkdtempSync(path.join(root, "readme cli "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    source: path.join(dir, "source readme.md"),
    destination: path.join(dir, "output readme.md"),
    sibling: path.join(dir, "unrelated file.txt"),
  };
}

function run(...args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

test("CLI writes exact transformed bytes without changing source or sibling, and truncates output", (t) => {
  const { source, destination, sibling } = fixture(t);
  const input = '<img src="doc/assets/banner.jpg">\n<source srcset="doc/assets/a.png, doc/assets/b.png">\n[docs](doc/assets/readme.md)\n';
  const expected = `<img src="${base}banner.jpg">\n<source srcset="${base}a.png, ${base}b.png">\n[docs](doc/assets/readme.md)\n`;
  const sentinel = "unrelated content\n";
  writeFileSync(source, input);
  writeFileSync(sibling, sentinel);
  assert.equal(prepareNpmReadme(input, ref), expected);
  const first = run(source, destination, ref);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(readFileSync(destination), Buffer.from(expected));
  assert.deepEqual(readFileSync(source), Buffer.from(input));
  assert.deepEqual(readFileSync(sibling), Buffer.from(sentinel));

  const short = "short\n";
  writeFileSync(source, short);
  const second = run(source, destination, ref);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(readFileSync(destination), Buffer.from(short));
  assert.deepEqual(readFileSync(source), Buffer.from(short));
  assert.deepEqual(readFileSync(sibling), Buffer.from(sentinel));
});

test("missing required arguments fail without creating or modifying destination", (t) => {
  const { source, destination, sibling } = fixture(t);
  writeFileSync(source, "source\n");
  writeFileSync(sibling, "sibling\n");
  for (const args of [[], [source], [source, destination]]) {
    const result = run(...args);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(destination), false);
  }
  writeFileSync(destination, "existing sentinel\n");
  const result = run(source, destination);
  assert.notEqual(result.status, 0);
  assert.deepEqual(readFileSync(destination), Buffer.from("existing sentinel\n"));
  assert.deepEqual(readFileSync(source), Buffer.from("source\n"));
  assert.deepEqual(readFileSync(sibling), Buffer.from("sibling\n"));
});

test("missing source fails without creating or modifying destination", (t) => {
  const { source, destination, sibling } = fixture(t);
  writeFileSync(sibling, "sibling\n");
  const first = run(source, destination, ref);
  assert.notEqual(first.status, 0);
  assert.equal(existsSync(destination), false);
  writeFileSync(destination, "existing sentinel\n");
  const second = run(source, destination, ref);
  assert.notEqual(second.status, 0);
  assert.deepEqual(readFileSync(destination), Buffer.from("existing sentinel\n"));
  assert.deepEqual(readFileSync(sibling), Buffer.from("sibling\n"));
});
