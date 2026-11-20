import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cli = resolve(dirname(fileURLToPath(import.meta.url)), "../../bootstrap-npm-package.mjs");
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? join(homedir(), ".cache", "myrmidon-tests");
const usage = [
  "Usage:",
  "  node scripts/bootstrap-npm-package.mjs <package-name> [--publish]",
  "",
  "Publishes an empty placeholder at version 0.0.0 that reserves <package-name> on npm",
  "so the release-bootstrap CI gate passes and trusted publishing can be configured.",
  "Real package content is only ever published by CI. Without --publish this is a dry run.",
  "",
  "With --publish the helper prompts for npm one-time passwords interactively",
  "(publish and deprecate each need their own code) and hands them to npm via its",
  "environment, so codes never appear on a command line.",
  "",
  "Examples:",
  "  node scripts/bootstrap-npm-package.mjs @myrmidon/new-package",
  "  node scripts/bootstrap-npm-package.mjs @myrmidon/new-package --publish",
  "",
].join("\n");

function fixture(t) {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "npm-preflight-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const tmp = join(root, "tmp");
  const journal = join(root, "journal");
  mkdirSync(bin);
  mkdirSync(tmp);
  writeFileSync(journal, "");
  writeFileSync(join(bin, "npm"), `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nappendFileSync(process.env.JOURNAL, JSON.stringify(process.argv.slice(2)) + '\\n');\nif (process.argv[2] === 'view') { process.stdout.write('"1.2.3"\\n'); } else { process.exitCode = 90; }\n`, { mode: 0o755 });
  return { root, tmp, journal, env: { PATH: bin, HOME: root, TMPDIR: tmp, TMP: tmp, TEMP: tmp, JOURNAL: journal } };
}

function run(f, args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: f.root, env: f.env, input: "", timeout: 10000, encoding: "utf8",
  });
  assert.equal(result.error, undefined, "CLI must start and finish before timeout");
  assert.equal(result.signal, null);
  return result;
}

function check(f, args, status, stderr, calls = []) {
  const result = run(f, args);
  assert.equal(result.status, status);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, stderr);
  assert.equal(readFileSync(f.journal, "utf8"), calls.map((call) => `${JSON.stringify(call)}\n`).join(""));
  assert.deepEqual(readdirSync(f.tmp), []);
}

for (const flag of ["--help", "-h"]) {
  test(`${flag} prints usage without side effects`, (t) => {
    check(fixture(t), [flag], 0, usage);
  });
}

test("missing package name prints usage and fails before npm", (t) => {
  check(fixture(t), [], 1, `${usage}missing package name\n`);
});

test("unknown option fails before npm", (t) => {
  check(fixture(t), ["--unknown"], 1, "unknown option: --unknown\n");
});

test("foreign package name fails before npm", (t) => {
  check(fixture(t), ["@foreign/package"], 1, 'refusing to publish a placeholder for "@foreign/package": the name must be a lowercase package inside the @myrmidon scope (this guard prevents accidental publishes to names we do not own).\n');
});

test("publish with piped stdin fails before npm", (t) => {
  check(fixture(t), ["@myrmidon/example", "--publish"], 1, "--publish needs an interactive terminal: the helper prompts for npm one-time passwords instead of taking them as arguments.\n");
});

test("existing package stops after npm view, before auth or staging", (t) => {
  check(fixture(t), ["@myrmidon/example"], 1, "@myrmidon/example already exists on npm at version 1.2.3; the bootstrap flow is only for names that have never been published\n", [["view", "@myrmidon/example", "version", "--json"]]);
});
