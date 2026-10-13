// scripts/myrmidon/bot-runtime/devbuild-env-key.test.mjs
//
// myrmidon(1.6.5 DEVBUILD-IN-BOTS): the devbuild CLI accepts the build-VPS
// key as the env DEVBUILD_SSH_KEY_DATA when the /opt/devbuild-ssh file is not
// mounted — the board hands keys to bots as secret env, not as mounts. The
// script must materialize the env key into a private 0600 file outside
// /workspace, pass it to ssh, and still fail the same way as before when
// neither the file nor the env key is available.
//
// These tests run the real script with a stubbed `ssh`/`rsync` pair on PATH:
// the stubs record their argv and exit 0, so no network and no real key are
// involved.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, statSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DEVBUILD = path.resolve("docker/bot-runtime/devbuild/devbuild");

const FAKE_KEY = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "FAKE-TEST-KEY-NOT-REAL",
  "-----END OPENSSH PRIVATE KEY-----",
].join("\n");

function makeHarness() {
  const root = mkdtempSync(path.join(tmpdir(), "devbuild-env-key-"));
  const bin = path.join(root, "bin");
  const scratch = path.join(root, "scratch");
  const ws = path.join(root, "workspace");
  mkdirSync(bin);
  mkdirSync(scratch);
  mkdirSync(ws);
  writeFileSync(path.join(ws, "marker.txt"), "hello\n");
  const argvLog = path.join(root, "argv.log");
  for (const tool of ["ssh", "rsync"]) {
    writeFileSync(
      path.join(bin, tool),
      `#!/bin/sh\necho "${tool} $@" >> "${argvLog}"\nexit 0\n`,
      { mode: 0o755 },
    );
  }
  const env = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: root,
    TMPDIR: scratch,
    DEVBUILD_HOST: "build.example.invalid",
    DEVBUILD_USER: "devbuild",
    DEVBUILD_BASE: "/srv/devbuild",
    DEVBUILD_SSH_KEY: path.join(root, "no-such-key"), // absent file
    DEVBUILD_WORKSPACE: ws,
  };
  return { root, bin, scratch, ws, argvLog, env };
}

function run(h, extraEnv = {}) {
  return spawnSync("bash", [DEVBUILD, "true"], { env: { ...h.env, ...extraEnv }, encoding: "utf8" });
}

test("env key materializes into a private 0600 file under the scratch and ssh uses it", () => {
  const h = makeHarness();
  const r = run(h, { DEVBUILD_SSH_KEY_DATA: FAKE_KEY });
  assert.equal(r.status, 0, r.stderr);
  const log = readFileSync(h.argvLog, "utf8");
  const m = log.match(/ssh .*-i (\S+)/);
  assert.ok(m, `ssh invocation has -i <key>: ${log}`);
  const keyPath = m[1];
  assert.ok(!keyPath.startsWith(h.ws), "key file must not live in /workspace");
  assert.ok(keyPath.startsWith(h.scratch), `key file lives under the scratch: ${keyPath}`);
  // The process exited: the per-process key directory must be gone (trap).
  assert.ok(!existsSync(keyPath), "materialized key removed on exit");
});

test("an existing readable key file wins over the env key", () => {
  const h = makeHarness();
  const realKey = path.join(h.root, "id_ed25519");
  writeFileSync(realKey, FAKE_KEY, { mode: 0o600 });
  const r = run(h, { DEVBUILD_SSH_KEY: realKey, DEVBUILD_SSH_KEY_DATA: "SHOULD-NOT-BE-USED" });
  assert.equal(r.status, 0, r.stderr);
  const log = readFileSync(h.argvLog, "utf8");
  assert.match(log, new RegExp(`ssh .*-i ${realKey.replace(/[/.]/g, "\\$&")}`));
});

test("no file, no env key: the old clear error is unchanged", () => {
  const h = makeHarness();
  const r = run(h);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ssh key .* is missing or not readable/);
  assert.match(r.stderr, /devbuild skill/);
});

test("env var documentation mentions DEVBUILD_SSH_KEY_DATA", () => {
  const r = spawnSync("bash", [DEVBUILD, "--help"], { encoding: "utf8" });
  assert.match(r.stdout, /DEVBUILD_SSH_KEY_DATA/);
});

test("missing DEVBUILD_HOST still fails before touching the key", () => {
  const h = makeHarness();
  delete h.env.DEVBUILD_HOST;
  const r = run(h, { DEVBUILD_SSH_KEY_DATA: FAKE_KEY });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /DEVBUILD_HOST/);
});
