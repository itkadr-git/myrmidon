import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const shared = "packages/shared";
const sdk = "packages/plugins/sdk";

function fixture(t, missingConfig) {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(os.homedir(), ".cache", "myrmidon-contract-tests");
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "build-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.copyFileSync(new URL("../../ensure-plugin-build-deps.mjs", import.meta.url), path.join(root, "scripts/ensure-plugin-build-deps.mjs"));
  const write = (name, contents) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  };
  write("node_modules/typescript/bin/tsc", `
const fs = require("node:fs");
const path = require("node:path");
const target = path.dirname(process.argv[3]);
fs.appendFileSync("builds", path.relative(process.cwd(), target) + "\\n");
fs.mkdirSync(path.join(target, "dist"), { recursive: true });
fs.writeFileSync(path.join(target, "dist/index.js"), "export {};\\n");
`);
  for (const target of [shared, sdk]) {
    write(`${target}/src/index.ts`, "export {};\n");
    write(`${target}/tsconfig.json`, "{}\n");
    write(`${target}/package.json`, '{"version":"1"}\n');
  }
  for (const file of ["tsconfig.json", "tsconfig.base.json", "node_modules/typescript/package.json"]) {
    if (file !== missingConfig) write(file, '{"version":"1"}\n');
  }
  const run = () => {
    const result = spawnSync(process.execPath, ["scripts/ensure-plugin-build-deps.mjs"], { cwd: root, encoding: "utf8", timeout: 15000, env: { ...process.env, TMPDIR: root } });
    assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  const builds = () => fs.readFileSync(path.join(root, "builds"), "utf8").trim().split("\n");
  return { root, write, run, builds };
}

const cases = [
  [`${shared}/tsconfig.json`, [shared, sdk]],
  [`${sdk}/tsconfig.json`, [sdk]],
  ["tsconfig.json", [shared, sdk]],
  ["tsconfig.base.json", [shared, sdk]],
  ["node_modules/typescript/package.json", [shared, sdk]],
  [`${shared}/package.json`, [shared, sdk]],
  [`${sdk}/package.json`, [sdk]],
];

for (const [file, expected] of cases) {
  test(`content change in ${file} invalidates exactly its dependent builds`, (t) => {
    const f = fixture(t);
    f.run();
    assert.deepEqual(f.builds(), [shared, sdk]);
    const absolute = path.join(f.root, file);
    const { atime, mtime } = fs.statSync(absolute);
    fs.appendFileSync(absolute, " ");
    fs.utimesSync(absolute, atime, mtime);
    assert.equal(fs.statSync(absolute).mtimeMs, mtime.getTime());
    f.run();
    assert.deepEqual(f.builds(), [shared, sdk, ...expected]);
    const output = f.run();
    assert.deepEqual(f.builds(), [shared, sdk, ...expected]);
    assert.doesNotMatch(output, /Building/);
  });
}

for (const file of ["tsconfig.json", "tsconfig.base.json"]) {
  test(`appearance of optional ${file} invalidates both targets`, (t) => {
    const f = fixture(t, file);
    f.run();
    assert.deepEqual(f.builds(), [shared, sdk]);
    f.write(file, '{}\n');
    f.run();
    assert.deepEqual(f.builds(), [shared, sdk, shared, sdk]);
    assert.doesNotMatch(f.run(), /Building/);
    assert.deepEqual(f.builds(), [shared, sdk, shared, sdk]);
  });
}
