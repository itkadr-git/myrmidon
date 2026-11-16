import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const shared = "packages/shared/tsconfig.json";
const sdk = "packages/plugins/sdk/tsconfig.json";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-config-invalidation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, contents) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  };
  fs.mkdirSync(path.join(root, "scripts"));
  fs.copyFileSync(new URL("../../ensure-plugin-build-deps.mjs", import.meta.url), path.join(root, "scripts/ensure-plugin-build-deps.mjs"));
  for (const target of ["packages/shared", "packages/plugins/sdk"]) {
    write(`${target}/src/index.ts`, "export {};\n");
    write(`${target}/tsconfig.json`, "{}\n");
    write(`${target}/package.json`, '{"version":"1.0.0"}\n');
  }
  write("tsconfig.json", "{}\n");
  write("tsconfig.base.json", "{}\n");
  write("node_modules/typescript/package.json", '{"version":"1.0.0"}\n');
  write("node_modules/typescript/bin/tsc", `
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.length !== 4 || process.argv[2] !== '-p') process.exit(2);
const config = path.relative(process.cwd(), process.argv[3]);
fs.appendFileSync('invocations', config + '\\n');
const dist = path.join(path.dirname(process.argv[3]), 'dist');
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, 'index.js'), 'export {};\\n');
`);
  const run = (expected) => {
    const result = spawnSync(process.execPath, ["scripts/ensure-plugin-build-deps.mjs"], {
      cwd: root, encoding: "utf8", timeout: 10000,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    const log = path.join(root, "invocations");
    const invocations = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
    assert.deepEqual(invocations, expected);
    const lines = expected.slice(run.previous || 0).map((config) =>
      `[paperclip] Building ${config === shared ? "@myrmidon/shared" : "@myrmidon/plugin-sdk"}...`);
    assert.equal(result.stdout, lines.length ? `${lines.join("\n")}\n` : "");
    assert.equal(result.stderr, "");
    run.previous = expected.length;
  };
  return { root, run };
}

for (const [name, config, rebuild] of [
  ["SDK tsconfig", sdk, [sdk]],
  ["SDK package", "packages/plugins/sdk/package.json", [sdk]],
  ["shared tsconfig", shared, [shared, sdk]],
  ["shared package", "packages/shared/package.json", [shared, sdk]],
  ["root tsconfig", "tsconfig.json", [shared, sdk]],
  ["root base tsconfig", "tsconfig.base.json", [shared, sdk]],
  ["TypeScript version", "node_modules/typescript/package.json", [shared, sdk]],
]) {
  test(`${name} content invalidates the appropriate builds with unchanged mtime`, (t) => {
    const { root, run } = fixture(t);
    const initial = [shared, sdk];
    const file = path.join(root, config);
    const time = new Date(1_600_000_000_000);
    fs.utimesSync(file, time, time);
    run(initial);
    const before = fs.statSync(file).mtimeMs;
    assert.equal(before, time.getTime());
    const contents = JSON.parse(fs.readFileSync(file, "utf8"));
    contents[name === "TypeScript version" ? "version" : "contractTest"] = "changed";
    fs.writeFileSync(file, `${JSON.stringify(contents)}\n`);
    fs.utimesSync(file, time, time);
    assert.equal(fs.statSync(file).mtimeMs, before);
    const expected = [...initial, ...rebuild];
    run(expected);
    run(expected);
  });
}
