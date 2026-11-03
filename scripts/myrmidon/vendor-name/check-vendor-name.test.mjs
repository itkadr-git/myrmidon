#!/usr/bin/env node
// Behavior test for scripts/myrmidon/vendor-name/check-vendor-name.mjs.
//
// The gate must (see docs/myrmidon/guides/rebrand-vendor-name.md):
//   1. pass on the committed snapshot fixtures (baseline 17, ratchet);
//   2. fail when a snapshot grows one visible mention above the baseline
//      (that is the whole point of the ratchet);
//   3. pass when the extra mention is an allowlisted span (X-Paperclip-*);
//   4. fail in strict mode even at the baseline count;
//   5. report --mode/MYRMIDON_VENDOR_NAME_CHECK_MODE precedence over the policy;
//   6. exit 2, never 0, when the policy file or the target directory is missing.
//
// Run: node --test scripts/myrmidon/vendor-name/check-vendor-name.test.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../../../..");
const CHECK = path.join(SCRIPT_DIR, "check-vendor-name.mjs");
const SNAPSHOTS = path.join(SCRIPT_DIR, "snapshots");

function runCheck(args, env = {}) {
  return runCheckAt(CHECK, args, env);
}

/** Run a copy of the gate from `dir` (its policy resolves next to the copy). */
function runCheckFrom(dir, args = ["--target", "snapshots"], env = {}) {
  return runCheckAt(path.join(dir, "check-vendor-name.mjs"), args, env);
}

function runCheckAt(script, args, env) {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.status ?? 1, stdout: String(error.stdout ?? "") };
  }
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Copy the committed snapshots into a scratch dir, optionally edited. */
function scratchSnapshots(edit) {
  const dir = tempDir("vendor-name-test-");
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(SNAPSHOTS)) {
    const source = path.join(SNAPSHOTS, name);
    if (fs.statSync(source).isFile()) fs.copyFileSync(source, path.join(dir, name));
  }
  if (edit) edit(dir);
  return dir;
}

test("real snapshots pass the gate in ratchet mode", () => {
  const res = runCheck(["--target", "snapshots"]);
  assert.equal(res.code, 0, res.stdout);
  assert.match(res.stdout, /snapshots: \d+ visible \/ \d+ identifier/);
  assert.match(res.stdout, /vendor-name gate: ok/);
});

test("one extra visible mention above the baseline fails the ratchet", () => {
  const dir = scratchSnapshots((d) => {
    const openapi = path.join(d, "openapi.json");
    const body = JSON.parse(fs.readFileSync(openapi, "utf8"));
    body.description += " Powered by Paperclip.";
    fs.writeFileSync(openapi, `${JSON.stringify(body, null, 2)}\n`);
  });
  const res = runCheck(["--target", "snapshots", "--snapshots", dir]);
  assert.equal(res.code, 1, res.stdout);
  assert.match(res.stdout, /vendor-name gate: violation/);
});

test("an allowlisted span does not count as visible", () => {
  const dir = scratchSnapshots((d) => {
    const openapi = path.join(d, "openapi.json");
    const body = JSON.parse(fs.readFileSync(openapi, "utf8"));
    body.description += " Traces flow to X-Paperclip-Trace headers.";
    fs.writeFileSync(openapi, `${JSON.stringify(body, null, 2)}\n`);
  });
  const res = runCheck(["--target", "snapshots", "--snapshots", dir]);
  assert.equal(res.code, 0, res.stdout);
});

test("strict mode fails on any visible occurrence at the baseline", () => {
  const res = runCheck(["--target", "snapshots", "--mode", "strict"]);
  assert.equal(res.code, 1, res.stdout);
  assert.match(res.stdout, /mode strict/);
});

test("MYRMIDON_VENDOR_NAME_CHECK_MODE overrides the policy file", () => {
  const res = runCheck(["--target", "snapshots"], { MYRMIDON_VENDOR_NAME_CHECK_MODE: "strict" });
  assert.equal(res.code, 1, res.stdout);
  assert.match(res.stdout, /mode strict \(env\)/);
});

test("MYRMIDON_VENDOR_NAME_CHECK_BASELINE lifts the ratchet ceiling", () => {
  const dir = scratchSnapshots((d) => {
    const openapi = path.join(d, "openapi.json");
    const body = JSON.parse(fs.readFileSync(openapi, "utf8"));
    body.description += " Powered by Paperclip.";
    fs.writeFileSync(openapi, `${JSON.stringify(body, null, 2)}\n`);
  });
  const res = runCheck(
    ["--target", "snapshots", "--snapshots", dir],
    { MYRMIDON_VENDOR_NAME_CHECK_BASELINE: "18" },
  );
  assert.equal(res.code, 0, res.stdout);
});

test("a missing policy file is an error, never clean", () => {
  const dir = tempDir("vendor-name-test-");
  // A copy of the gate with no policy file next to it must exit 2, not 0.
  fs.copyFileSync(CHECK, path.join(dir, "check-vendor-name.mjs"));
  const res = runCheckFrom(dir);
  assert.equal(res.code, 2, res.stdout);
});
