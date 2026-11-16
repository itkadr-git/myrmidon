import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const shared = "packages/shared";
const sdk = "packages/plugins/sdk";

test("SDK source changes rebuild only SDK and reuse shared output", (t) => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(os.homedir(), ".cache", "myrmidon-tests");
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "sdk-invalidation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.copyFileSync(new URL("../../ensure-plugin-build-deps.mjs", import.meta.url), path.join(root, "scripts/ensure-plugin-build-deps.mjs"));
  const compiler = path.join(root, "node_modules/typescript/bin/tsc");
  fs.mkdirSync(path.dirname(compiler), { recursive: true });
  fs.writeFileSync(compiler, `
const fs = require("node:fs");
const path = require("node:path");
const target = path.dirname(process.argv[3]);
fs.appendFileSync("builds", path.relative(process.cwd(), target) + "\\n");
fs.mkdirSync(path.join(target, "dist"), { recursive: true });
fs.writeFileSync(path.join(target, "dist/index.js"), "export {};\\n");
`);
  for (const target of [shared, sdk]) {
    fs.mkdirSync(path.join(root, target, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, target, "src/index.ts"), "export {};\n");
    fs.writeFileSync(path.join(root, target, "tsconfig.json"), "{}");
  }
  const run = () => {
    const result = spawnSync(process.execPath, ["scripts/ensure-plugin-build-deps.mjs"], {
      cwd: root, env: { ...process.env, TMPDIR: root }, encoding: "utf8", timeout: 15000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout;
  };
  const log = () => fs.readFileSync(path.join(root, "builds"), "utf8");
  run();
  assert.equal(log(), `${shared}\n${sdk}\n`);
  const marker = path.join(root, shared, "dist/.paperclip-build-complete");
  const sharedMarker = fs.readFileSync(marker);
  const assertSdkOnly = (previous) => {
    const output = run();
    assert.match(output, /Building @myrmidon\/plugin-sdk/);
    assert.doesNotMatch(output, /Building @myrmidon\/shared/);
    assert.equal(log(), previous + `${sdk}\n`);
    assert.deepEqual(fs.readFileSync(marker), sharedMarker);
  };
  const source = path.join(root, sdk, "src/index.ts");
  const oldTime = fs.statSync(source).mtime;
  fs.appendFileSync(source, "export const changed = true;\n");
  fs.utimesSync(source, oldTime, oldTime);
  assert.equal(fs.statSync(source).mtimeMs, oldTime.getTime());
  assertSdkOnly(`${shared}\n${sdk}\n`);
  const afterChange = log();
  assert.doesNotMatch(run(), /Building/);
  assert.equal(log(), afterChange);
  assert.deepEqual(fs.readFileSync(marker), sharedMarker);
  const nested = path.join(root, sdk, "src/nested/extra.ts");
  fs.mkdirSync(path.dirname(nested));
  fs.writeFileSync(nested, "export const nested = true;\n");
  assertSdkOnly(afterChange);
  const afterCreate = log();
  fs.unlinkSync(nested);
  assertSdkOnly(afterCreate);
  const afterDelete = log();
  assert.doesNotMatch(run(), /Building/);
  assert.equal(log(), afterDelete);
  assert.deepEqual(fs.readFileSync(marker), sharedMarker);
});
