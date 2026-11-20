import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../../select-cloud-cache.mjs", import.meta.url));
const image = "ghcr.io/example/cache";
const shas = ["a".repeat(40), "b".repeat(40), "c".repeat(40)];
const refs = [...shas.map((sha) => `${image}:buildcache-cloud-${sha}`), `${image}:buildcache-cloud`];
const gitCall = ["git", "rev-list", "--first-parent", "--max-count=10", "HEAD"];
const inspect = (ref) => ["docker", "buildx", "imagetools", "inspect", "--raw", ref];

function run({ responses = {}, commits = shas, cacheImage = image, output = true, cliPath = cli } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cloud-cache-ports-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const log = join(dir, "calls");
    const outputPath = join(dir, "output");
    writeFileSync(log, "");
    writeFileSync(outputPath, "previous=value\n");
    const fake = `#!${process.execPath}\n` + `
const fs = require('node:fs');
const path = require('node:path');
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify([name, ...args]) + '\\n');
if (name === 'git') {
  if (JSON.stringify(args) !== JSON.stringify(['rev-list', '--first-parent', '--max-count=10', 'HEAD'])) process.exit(90);
  process.stdout.write(process.env.COMMITS);
} else {
  if (args.length !== 5 || JSON.stringify(args.slice(0, 4)) !== JSON.stringify(['buildx', 'imagetools', 'inspect', '--raw'])) process.exit(91);
  const result = JSON.parse(process.env.RESPONSES)[args[4]] ?? 'manifest unknown';
  if (result !== 'ok') { process.stderr.write(result); process.exit(1); }
  process.stdout.write('{}');
}
`;
    for (const name of ["git", "docker"]) writeFileSync(join(bin, name), fake, { mode: 0o755 });
    const env = { PATH: `${bin}:/usr/bin:/bin`, CALL_LOG: log, COMMITS: `${commits.join("\n")}\n`, RESPONSES: JSON.stringify(responses), CACHE_IMAGE: cacheImage };
    if (output) env.GITHUB_OUTPUT = outputPath;
    const result = spawnSync(process.execPath, [cliPath], { env, encoding: "utf8", timeout: 15000 });
    assert.equal(result.error, undefined);
    const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    return { ...result, calls, output: readFileSync(outputPath, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function success(result, expectedRefs, selected) {
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [gitCall, ...expectedRefs.map(inspect)]);
  assert.equal(result.output, `previous=value\nsource=${selected ? `type=registry,ref=${selected}` : ""}\n`);
}

test("same SHA cache wins immediately", () => {
  success(run({ responses: { [refs[0]]: "ok" } }), refs.slice(0, 1), refs[0]);
});
test("nearest available ancestor wins", () => {
  success(run({ responses: { [refs[1]]: "ok", [refs[2]]: "ok" } }), refs.slice(0, 2), refs[1]);
});
test("older ancestor wins when previous caches miss", () => {
  success(run({ responses: { [refs[2]]: "ok" } }), refs.slice(0, 3), refs[2]);
});
test("legacy cache wins only after SHA caches miss", () => {
  success(run({ responses: { [refs[3]]: "ok" } }), refs, refs[3]);
});
for (const message of ["manifest unknown", "not found", "NAME_UNKNOWN"]) {
  test(`${message} is a cache miss`, () => {
    const result = run({ responses: Object.fromEntries(refs.map((ref) => [ref, message])) });
    success(result, refs, null);
    assert.doesNotMatch(result.stdout, /Could not inspect cloud cache/);
  });
}
test("other inspection errors fail over to the next cache", () => {
  const result = run({ responses: { [refs[0]]: "connection refused", [refs[1]]: "ok" } });
  success(result, refs.slice(0, 2), refs[1]);
  assert.match(result.stdout, /Could not inspect cloud cache/);
});
test("all inspection errors permit a cold build", () => {
  const result = run({ responses: Object.fromEntries(refs.map((ref) => [ref, "connection refused"])) });
  success(result, refs, null);
  assert.match(result.stdout, /Could not inspect cloud cache/);
});
test("missing GITHUB_OUTPUT fails before invoking any port", () => {
  const result = run({ output: false });
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.calls, []);
  assert.equal(result.output, "previous=value\n");
});
for (const [name, options] of [
  ["invalid image", { cacheImage: "ghcr.io/example/cache\nsource=injected" }],
  ["invalid SHA", { commits: ["not-a-full-sha"] }],
  ["empty ancestry", { commits: [] }],
]) {
  test(`${name} fails before Docker and preserves output`, () => {
    const result = run(options);
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.calls, [gitCall]);
    assert.equal(result.output, "previous=value\n");
  });
}
