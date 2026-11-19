import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = resolve(dirname(fileURLToPath(import.meta.url)), "../../bootstrap-npm-package.mjs");
const name = "@myrmidon/integration-placeholder";

test("CLI dry run stages only a public placeholder and cleans it up", (t) => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), ".cache", "myrmidon-test");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "npm-cli-dryrun-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const tmp = join(root, "tmp");
  const log = join(root, "calls.jsonl");
  mkdirSync(bin);
  mkdirSync(tmp);
  writeFileSync(join(bin, "npm"), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const call = { args, cwd: process.cwd() };
if (args[0] === 'publish') {
  call.files = fs.readdirSync(process.cwd()).sort();
  call.payload = Object.fromEntries(call.files.map(file => [file, fs.readFileSync(path.join(process.cwd(), file), 'utf8')]));
}
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify(call) + '\\n');
if (args[0] === 'view') { process.stderr.write('npm ERR! code E404\\n'); process.exit(1); }
if (JSON.stringify(args) !== JSON.stringify(['publish', '--dry-run', '--access', 'public'])) process.exit(2);
`, { mode: 0o755 });
  const env = { PATH: bin, HOME: root, TMPDIR: tmp, TMP: tmp, TEMP: tmp, CALL_LOG: log };
  const result = spawnSync(process.execPath, [cli, name], { env, cwd: root, timeout: 10000, encoding: "utf8" });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { args: ["view", name, "version", "--json"], cwd: root });
  const staged = calls[1];
  assert.deepEqual(staged.args, ["publish", "--dry-run", "--access", "public"]);
  assert.equal(dirname(staged.cwd), tmp);
  assert.equal(existsSync(staged.cwd), false);
  assert.deepEqual(staged.files, ["README.md", "index.js", "package.json"]);
  const manifest = JSON.parse(staged.payload["package.json"]);
  assert.equal(manifest.name, name);
  assert.equal(manifest.version, "0.0.0");
  assert.equal(manifest.main, "index.js");
  assert.deepEqual(manifest.files, ["index.js"]);
  assert.deepEqual(manifest.publishConfig, { access: "public" });
  for (const key of ["private", "workspaces", "dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "scripts", "bin"]) {
    assert.equal(Object.hasOwn(manifest, key), false, key);
  }
  assert.match(staged.payload["README.md"], /^# @myrmidon\/integration-placeholder\n/);
  assert.match(staged.payload["README.md"], /Version 0\.0\.0 is a \*\*placeholder publish\*\*/);
  assert.match(staged.payload["README.md"], /contains no functionality/);
  const entry = join(root, "index.js");
  writeFileSync(entry, staged.payload["index.js"]);
  const execute = spawnSync(process.execPath, ["-e", "try { require(process.argv[1]); process.exitCode = 2; } catch (e) { process.stdout.write(JSON.stringify({name:e.name,message:e.message})); }", entry], { env, cwd: root, timeout: 10000, encoding: "utf8" });
  assert.equal(execute.error, undefined);
  assert.equal(execute.signal, null);
  assert.equal(execute.status, 0);
  assert.equal(execute.stderr, "");
  const error = JSON.parse(execute.stdout);
  assert.deepEqual(Object.keys(error), ["name", "message"]);
  assert.equal(error.name, "Error");
  assert.match(error.message, /^@myrmidon\/integration-placeholder@0\.0\.0 is a placeholder that reserves the package name /);
  assert.match(error.message, /contains no functionality; the first real release supersedes it/);
  assert.equal(result.stdout, `${name} is not on npm yet; continuing with placeholder bootstrap.\nStaged placeholder for ${name} in ${staged.cwd}\nPreviewing publish payload (npm publish --dry-run)...\n\nDry run complete. To publish the placeholder from an authenticated maintainer machine, run:\nnode scripts/bootstrap-npm-package.mjs ${name} --publish\n`);
});
