import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const moduleUrl = new URL("../../bootstrap-npm-package.mjs", import.meta.url).href;
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? join(homedir(), ".cache", "myrmidon-tests");
const packageName = "@myrmidon/transport-fixture";

function inspect(t, response) {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "npm-inspect-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const log = join(root, "calls.jsonl");
  writeFileSync(join(bin, "npm"), `#!${process.execPath}\n` + `
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), status: ${response.status} }) + "\\n");
process.stdout.write(${JSON.stringify(response.stdout ?? "")});
process.stderr.write(${JSON.stringify(response.stderr ?? "")});
process.exitCode = ${response.status};
`, { mode: 0o755 });
  const script = `
import { inspectNpmPackage } from ${JSON.stringify(moduleUrl)};
try {
  process.stdout.write(JSON.stringify({ result: inspectNpmPackage(${JSON.stringify(packageName)}) }) + "\\n");
} catch (error) {
  process.stdout.write(JSON.stringify({ error: { name: error.name, message: error.message } }) + "\\n");
}
`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    env: { PATH: bin, HOME: root, TMPDIR: root, TMP: root, TEMP: root },
    timeout: 10000,
    encoding: "utf8",
  });
  assert.equal(child.error, undefined);
  assert.equal(child.signal, null);
  assert.equal(child.status, 0);
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n").map(JSON.parse), [
    { argv: ["view", packageName, "version", "--json"], status: response.status },
  ]);
  return child;
}

test("inspect returns the registry version without writing npm output", (t) => {
  const child = inspect(t, { status: 0, stdout: '"2.4.6"\n' });
  assert.equal(child.stdout, '{"result":{"exists":true,"version":"2.4.6"}}\n');
  assert.equal(child.stderr, "");
});

for (const stream of ["stdout", "stderr"]) {
  test(`inspect suppresses expected E404 on ${stream}`, (t) => {
    const child = inspect(t, { status: 1, [stream]: "npm ERR! E404 missing fixture\n" });
    assert.equal(child.stdout, '{"result":{"exists":false}}\n');
    assert.equal(child.stderr, "");
  });
}

for (const code of ["E403", "E500"]) {
  test(`inspect reports unexpected ${code} with diagnostics`, (t) => {
    const child = inspect(t, { status: 1, stderr: `npm ERR! ${code} diagnostic\n` });
    assert.equal(child.stdout, `{"error":{"name":"Error","message":"failed to query npm for ${packageName}"}}\n`);
    assert.equal(child.stderr, `npm ERR! ${code} diagnostic\n`);
  });
}

test("inspect rejects invalid JSON with SyntaxError", (t) => {
  const child = inspect(t, { status: 0, stdout: "not-json\n" });
  const result = JSON.parse(child.stdout);
  assert.equal(result.error.name, "SyntaxError");
  assert.equal(typeof result.error.message, "string");
  assert.deepEqual(Object.keys(result), ["error"]);
  assert.deepEqual(Object.keys(result.error), ["name", "message"]);
  assert.equal(child.stderr, "");
});
