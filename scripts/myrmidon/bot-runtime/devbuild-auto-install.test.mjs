// scripts/myrmidon/bot-runtime/devbuild-auto-install.test.mjs
//
// myrmidon(1.6.9 DEVBUILD-AUTO-INSTALL): the devbuild client never ships
// node_modules, so a fresh remote copy has none and `vitest`/`tsc` fail with
// "command not found". The client now runs
// `pnpm install --frozen-lockfile --prefer-offline` in the same ssh session
// before the command when the copy has package.json and pnpm-lock.yaml but no
// node_modules.
//
// Same method as devbuild-env-key.test.mjs: the real script runs with stubbed
// `ssh`/`rsync` on PATH. Here the `ssh` stub executes the final remote command
// string locally with bash (the "cd '<dest>' && ..." call), against a temp
// "remote" copy, with stub `pnpm` and `mycmd` that record their calls.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DEVBUILD = path.resolve("docker/bot-runtime/devbuild/devbuild");

function makeHarness({ nodeModules = false, packageJson = true, lockfile = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "devbuild-auto-install-"));
  const bin = path.join(root, "bin");
  const ws = path.join(root, "workspace");
  const base = path.join(root, "remote-base");
  const dest = path.join(base, "tbot", "workspace");
  const calls = path.join(root, "calls.log");
  mkdirSync(bin);
  mkdirSync(ws);
  mkdirSync(dest, { recursive: true });
  writeFileSync(path.join(ws, "marker.txt"), "hello\n");
  if (packageJson) writeFileSync(path.join(dest, "package.json"), "{}\n");
  if (lockfile) writeFileSync(path.join(dest, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  if (nodeModules) mkdirSync(path.join(dest, "node_modules"));
  const key = path.join(root, "id_ed25519");
  writeFileSync(key, "FAKE-TEST-KEY-NOT-REAL\n", { mode: 0o600 });
  // Only the remote command call ("cd '<dest>' && ...") is executed; the
  // mkdir/rsync preparation calls are only recorded.
  writeFileSync(
    path.join(bin, "ssh"),
    `#!/bin/bash\nlast="\${@: -1}"\ncase "$last" in\n  "cd '"*) bash -c "$last" ;;\n  *) exit 0 ;;\nesac\n`,
    { mode: 0o755 },
  );
  writeFileSync(path.join(bin, "rsync"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(
    path.join(bin, "pnpm"),
    `#!/bin/sh\necho "pnpm $* store=$npm_config_store_dir" >> "${calls}"\n` +
      `if [ "$1" = "install" ] && [ -n "$PNPM_FAIL_RC" ]; then echo "ERR_PNPM_STUB_FAIL" >&2; exit "$PNPM_FAIL_RC"; fi\n` +
      `if [ "$1" = "install" ] || [ "$1" = "i" ]; then mkdir -p node_modules; fi\nexit 0\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(bin, "mycmd"),
    `#!/bin/sh\necho "mycmd nm=$([ -d node_modules ] && echo yes || echo no)" >> "${calls}"\nexit "\${MYCMD_RC:-0}"\n`,
    { mode: 0o755 },
  );
  const env = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: root,
    TMPDIR: root,
    DEVBUILD_HOST: "build.example.invalid",
    DEVBUILD_USER: "devbuild",
    DEVBUILD_BASE: base,
    DEVBUILD_BOT_NAME: "tbot",
    DEVBUILD_SSH_KEY: key,
    DEVBUILD_WORKSPACE: ws,
  };
  return { root, dest, calls, env };
}

function run(h, command, extraEnv = {}) {
  return spawnSync("bash", [DEVBUILD, command], { env: { ...h.env, ...extraEnv }, encoding: "utf8" });
}

function callLines(h) {
  return existsSync(h.calls) ? readFileSync(h.calls, "utf8").trim().split("\n") : [];
}

const NOTICE = "devbuild: node_modules отсутствует в копии — pnpm install";

test("(a) no node_modules: pnpm install runs first (shared store), then the command", () => {
  const h = makeHarness();
  const r = run(h, "mycmd");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stderr.includes(NOTICE), r.stderr);
  assert.deepEqual(callLines(h), [
    "pnpm install --frozen-lockfile --prefer-offline store=/srv/devcache/pnpm",
    "mycmd nm=yes",
  ]);
});

test("(b) node_modules present: only the command runs", () => {
  const h = makeHarness({ nodeModules: true });
  const r = run(h, "mycmd");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stderr.includes(NOTICE), r.stderr);
  assert.deepEqual(callLines(h), ["mycmd nm=yes"]);
});

test("no package.json or no lockfile: no install", () => {
  for (const opts of [{ packageJson: false }, { lockfile: false }]) {
    const h = makeHarness(opts);
    const r = run(h, "mycmd");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(callLines(h), ["mycmd nm=no"]);
  }
});

test("(c) the command already starts with pnpm install: no second install", () => {
  const h = makeHarness();
  const r = run(h, "pnpm install && mycmd");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stderr.includes(NOTICE), r.stderr);
  assert.deepEqual(callLines(h), ["pnpm install store=/srv/devcache/pnpm", "mycmd nm=yes"]);
});

test("(c2) leading spaces and `pnpm i` count as an install too", () => {
  const h = makeHarness();
  const r = run(h, "  pnpm i --frozen-lockfile && mycmd");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(callLines(h), ["pnpm i --frozen-lockfile store=/srv/devcache/pnpm", "mycmd nm=yes"]);
});

test("(d) DEVBUILD_NO_AUTO_INSTALL=1: no install, the command runs as before", () => {
  const h = makeHarness();
  const r = run(h, "mycmd", { DEVBUILD_NO_AUTO_INSTALL: "1" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stderr.includes(NOTICE), r.stderr);
  assert.deepEqual(callLines(h), ["mycmd nm=no"]);
});

test("(e) install fails: the command does not run, the exit code is the install's", () => {
  const h = makeHarness();
  const r = run(h, "mycmd", { PNPM_FAIL_RC: "7" });
  assert.equal(r.status, 7, r.stderr);
  assert.ok(r.stderr.includes(NOTICE), r.stderr);
  assert.match(r.stderr, /devbuild: pnpm install failed \(exit 7\), the command was not run/);
  assert.deepEqual(callLines(h), ["pnpm install --frozen-lockfile --prefer-offline store=/srv/devcache/pnpm"]);
});

test("the command's own exit code still passes through after a successful install", () => {
  const h = makeHarness();
  const r = run(h, "mycmd", { MYCMD_RC: "3" });
  assert.equal(r.status, 3, r.stderr);
});

test("help documents DEVBUILD_NO_AUTO_INSTALL", () => {
  const r = spawnSync("bash", [DEVBUILD, "--help"], { encoding: "utf8" });
  assert.match(r.stdout, /DEVBUILD_NO_AUTO_INSTALL/);
});
