import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { main } from "./check-prod-runtime-resolution.mjs";

const cli = fileURLToPath(new URL("./check-prod-runtime-resolution.mjs", import.meta.url));
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(os.homedir(), ".cache", "myrmidon-tests");

function fixture(run) {
  fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, "resolve-cli-"));
  try {
    const manifest = path.join(dir, "package.json");
    fs.writeFileSync(manifest, '{\n  "name": "fixture", "type": "module"\n}\n');
    const before = fs.readFileSync(manifest);
    try {
      run(dir);
    } finally {
      assert.deepEqual(fs.readFileSync(manifest), before, "manifest must remain byte-identical");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function invoke(cwd, args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    env: { PATH: process.env.PATH || "" },
    encoding: "utf8",
    shell: false,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

it("rejects missing dist, a file instead of a directory, and unknown options on stderr", () => fixture((dir) => {
  assert.equal(typeof main, "function");
  fs.writeFileSync(path.join(dir, "not-a-directory"), "file");
  for (const [args, message] of [
    [["--dist", "absent"], /dist не найден/],
    [["--dist", "not-a-directory"], /dist не найден/],
    [["--dist", ".", "--unknown"], /неизвестный аргумент: --unknown/],
  ]) {
    const result = invoke(dir, args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, message);
    assert.doesNotMatch(result.stderr, /сбоев в/);
  }
}));

it("reports an empty dist on stdout for both path forms with spaces", () => fixture((dir) => {
  fs.mkdirSync(path.join(dir, "dist with spaces"));
  const separate = invoke(dir, ["--dist", "dist with spaces"]);
  const equals = invoke(dir, ["--dist=dist with spaces"]);
  assert.deepEqual(equals, separate);
  assert.equal(separate.status, 0);
  assert.equal(separate.stdout, "0 сбоев в 0 пакетах\n");
  assert.equal(separate.stderr, "");
}));

it("reports a bad import and summary on stderr for both path forms with spaces", () => fixture((dir) => {
  const dist = path.join(dir, "dist with spaces");
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(dist, "index.js"), 'import "@myrmidon/missing";\n');
  const separate = invoke(dir, ["--dist", "dist with spaces"]);
  const equals = invoke(dir, ["--dist=dist with spaces"]);
  assert.deepEqual(equals, separate);
  assert.equal(separate.status, 1);
  assert.equal(separate.stdout, "");
  assert.match(separate.stderr, /dist with spaces\/index\.js:1 @myrmidon\/missing → пакет не найден/);
  assert.match(separate.stderr, /1 сбой в 1 пакете\n$/);
}));
