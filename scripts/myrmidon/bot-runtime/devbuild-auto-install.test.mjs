// scripts/myrmidon/bot-runtime/devbuild-auto-install.test.mjs
//
// myrmidon(1.6.9 DEVBUILD-AUTO-INSTALL): the devbuild client never ships
// node_modules, so a fresh remote copy has none and `vitest`/`tsc` fail with
// "command not found". For node-tool commands the client runs
// `pnpm install --frozen-lockfile --prefer-offline` in the same ssh session
// before the command when the copy has package.json and pnpm-lock.yaml but no
// completed install (pnpm's marker node_modules/.modules.yaml), under a lock.
//
// Same method as devbuild-env-key.test.mjs: the real script runs with stubbed
// `ssh`/`rsync` on PATH. Here the `ssh` stub executes the final remote command
// string locally with bash (the "cd '<dest>' && ..." call), against a temp
// "remote" copy, with stub `pnpm`, `vitest` and `go` that record their calls.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync, symlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DEVBUILD = path.resolve("docker/bot-runtime/devbuild/devbuild");

function makeHarness({ nodeModules = false, marker = true, packageJson = true, lockfile = true, noFlock = false, destMissing = false } = {}) {
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
  if (nodeModules) {
    mkdirSync(path.join(dest, "node_modules"));
    if (marker) writeFileSync(path.join(dest, "node_modules", ".modules.yaml"), "layoutVersion: 5\n");
  }
  const key = path.join(root, "id_ed25519");
  writeFileSync(key, "FAKE-TEST-KEY-NOT-REAL\n", { mode: 0o600 });
  // Only the remote command call ("cd '<dest>' && ...") is executed; the
  // mkdir/rsync preparation calls are ignored.
  writeFileSync(
    path.join(bin, "ssh"),
    `#!/bin/bash\nlast="\${@: -1}"\ncase "$last" in\n  "cd '"*) bash -c "$last" ;;\n  *) exit 0 ;;\nesac\n`,
    { mode: 0o755 },
  );
  writeFileSync(path.join(bin, "rsync"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  // pnpm stub: `install`/`i` take a moment (so parallel calls overlap), then
  // write the completion marker; PNPM_FAIL_RC makes them fail after leaving a
  // partial node_modules behind.
  writeFileSync(
    path.join(bin, "pnpm"),
    `#!/bin/sh\necho "pnpm $* store=$npm_config_store_dir" >> "${calls}"\n` +
      `if [ "$1" = "install" ] || [ "$1" = "i" ]; then\n` +
      `  mkdir -p node_modules; sleep 1\n` +
      `  if [ -n "$PNPM_FAIL_RC" ]; then echo "ERR_PNPM_STUB_FAIL" >&2; exit "$PNPM_FAIL_RC"; fi\n` +
      `  touch node_modules/.modules.yaml\nfi\nexit 0\n`,
    { mode: 0o755 },
  );
  for (const tool of ["vitest", "go"]) {
    writeFileSync(
      path.join(bin, tool),
      `#!/bin/sh\necho "${tool} $* nm=$([ -f node_modules/.modules.yaml ] && echo yes || echo no)" >> "${calls}"\nexit "\${CMD_RC:-0}"\n`,
      { mode: 0o755 },
    );
  }
  // noFlock: a PATH with only the stubs and the tools the script needs, no
  // `flock`, so the remote function takes the mkdir-lock fallback.
  if (noFlock) {
    for (const t of ["mkdir", "rmdir", "rm", "sleep", "touch", "find", "id", "tr", "cut", "sha256sum", "grep", "dirname", "basename", "chmod", "cat", "bash", "sh"]) {
      const src = ["/usr/bin/", "/bin/"].map((d) => d + t).find((f) => existsSync(f));
      if (src) symlinkSync(src, path.join(bin, t));
    }
  }
  if (destMissing) rmSync(dest, { recursive: true, force: true });
  const env = {
    PATH: noFlock ? bin : `${bin}:/usr/bin:/bin`,
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
  return spawnSync("/bin/bash", [DEVBUILD, command], { env: { ...h.env, ...extraEnv }, encoding: "utf8" });
}

function runAsync(h, command) {
  return new Promise((resolve) => {
    const child = spawn("/bin/bash", [DEVBUILD, command], { env: h.env });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (status) => resolve({ status, stderr }));
  });
}

function callLines(h) {
  return existsSync(h.calls) ? readFileSync(h.calls, "utf8").trim().split("\n") : [];
}

const NOTICE = "devbuild: node_modules отсутствует в копии — pnpm install";
const INSTALL = "pnpm install --frozen-lockfile --prefer-offline store=/srv/devcache/pnpm";

test("(a) no node_modules: pnpm install runs first (shared store), then the command", () => {
  const h = makeHarness();
  const r = run(h, "vitest run");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stderr.includes(NOTICE), r.stderr);
  assert.deepEqual(callLines(h), [INSTALL, "vitest run nm=yes"]);
});

test("(b) completed install present: only the command runs", () => {
  const h = makeHarness({ nodeModules: true });
  const r = run(h, "vitest run");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stderr.includes(NOTICE), r.stderr);
  assert.deepEqual(callLines(h), ["vitest run nm=yes"]);
});

test("partial node_modules without the marker: the install runs again", () => {
  const h = makeHarness({ nodeModules: true, marker: false });
  const r = run(h, "vitest run");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stderr.includes(NOTICE), r.stderr);
  assert.deepEqual(callLines(h), [INSTALL, "vitest run nm=yes"]);
});

test("no package.json or no lockfile: no install", () => {
  for (const opts of [{ packageJson: false }, { lockfile: false }]) {
    const h = makeHarness(opts);
    const r = run(h, "vitest run");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(callLines(h), ["vitest run nm=no"]);
  }
});

test("a non-node command with a lockfile present: no install", () => {
  const h = makeHarness();
  const r = run(h, "go test ./...");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stderr.includes(NOTICE), r.stderr);
  assert.deepEqual(callLines(h), ["go test ./... nm=no"]);
});

test("pnpm import and pnpm info: no extra install", () => {
  for (const sub of ["import", "info left-pad"]) {
    const h = makeHarness();
    const r = run(h, `pnpm ${sub}`);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stderr.includes(NOTICE), r.stderr);
    assert.deepEqual(callLines(h), [`pnpm ${sub} store=/srv/devcache/pnpm`]);
  }
});

test("(c) the command already starts with pnpm install: no second install", () => {
  const h = makeHarness();
  const r = run(h, "pnpm install && vitest run");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stderr.includes(NOTICE), r.stderr);
  assert.deepEqual(callLines(h), ["pnpm install store=/srv/devcache/pnpm", "vitest run nm=yes"]);
});

test("(c2) leading spaces and `pnpm i` count as an install too", () => {
  const h = makeHarness();
  const r = run(h, "  pnpm i --frozen-lockfile && vitest run");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(callLines(h), ["pnpm i --frozen-lockfile store=/srv/devcache/pnpm", "vitest run nm=yes"]);
});

test("(d) DEVBUILD_NO_AUTO_INSTALL=1: no install, the command runs as before", () => {
  const h = makeHarness();
  const r = run(h, "vitest run", { DEVBUILD_NO_AUTO_INSTALL: "1" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stderr.includes(NOTICE), r.stderr);
  assert.deepEqual(callLines(h), ["vitest run nm=no"]);
});

test("(e) install fails: the command does not run, the exit code is the install's, the partial node_modules is removed", () => {
  const h = makeHarness();
  const r = run(h, "vitest run", { PNPM_FAIL_RC: "7" });
  assert.equal(r.status, 7, r.stderr);
  assert.ok(r.stderr.includes(NOTICE), r.stderr);
  assert.match(r.stderr, /devbuild: pnpm install failed \(exit 7\), the command was not run/);
  assert.match(r.stderr, /DEVBUILD_NO_AUTO_INSTALL=1/);
  assert.deepEqual(callLines(h), [INSTALL]);
  assert.ok(!existsSync(path.join(h.dest, "node_modules")), "partial node_modules removed");
});

test("the command's own exit code still passes through after a successful install", () => {
  const h = makeHarness();
  const r = run(h, "vitest run", { CMD_RC: "3" });
  assert.equal(r.status, 3, r.stderr);
});

test("two parallel calls on one copy: one install, both commands run after it", async () => {
  const h = makeHarness();
  const [r1, r2] = await Promise.all([runAsync(h, "vitest run a"), runAsync(h, "vitest run b")]);
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(r2.status, 0, r2.stderr);
  const lines = callLines(h);
  assert.equal(lines.filter((l) => l.startsWith("pnpm install")).length, 1, lines.join("\n"));
  assert.deepEqual(lines.filter((l) => l.startsWith("vitest")).sort(), ["vitest run a nm=yes", "vitest run b nm=yes"]);
});

test("a missing copy directory: the command does not run in the login directory, the exit code is not 0", () => {
  for (const cmd of ["vitest run", "go test ./..."]) {
    const h = makeHarness({ destMissing: true });
    const r = run(h, cmd);
    assert.notEqual(r.status, 0, r.stderr);
    assert.deepEqual(callLines(h), []);
  }
});

test("mkdir-lock fallback (no flock): installs once and releases the lock, also after a failed install", () => {
  const h = makeHarness({ noFlock: true });
  const r = run(h, "vitest run");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(callLines(h), [INSTALL, "vitest run nm=yes"]);
  assert.ok(!existsSync(path.join(h.dest, ".devbuild-install.lock.d")), "lock directory released");
  const f = makeHarness({ noFlock: true });
  const rf = run(f, "vitest run", { PNPM_FAIL_RC: "7" });
  assert.equal(rf.status, 7, rf.stderr);
  assert.ok(!existsSync(path.join(f.dest, ".devbuild-install.lock.d")), "lock directory released after a failure");
});

test("mkdir-lock fallback: a stale lock (older than 30 min) is removed with a note, the install proceeds", () => {
  const h = makeHarness({ noFlock: true });
  const lock = path.join(h.dest, ".devbuild-install.lock.d");
  mkdirSync(lock);
  const old = new Date(Date.now() - 60 * 60 * 1000);
  utimesSync(lock, old, old);
  const r = run(h, "vitest run");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /removing a stale install lock/);
  assert.deepEqual(callLines(h), [INSTALL, "vitest run nm=yes"]);
  assert.ok(!existsSync(lock));
});

test("help documents DEVBUILD_NO_AUTO_INSTALL", () => {
  const r = spawnSync("bash", [DEVBUILD, "--help"], { encoding: "utf8" });
  assert.match(r.stdout, /DEVBUILD_NO_AUTO_INSTALL/);
});
