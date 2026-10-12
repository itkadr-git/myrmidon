// scripts/myrmidon/bot-runtime/devbuild-self-check.test.mjs
//
// myrmidon(1.6.5 DEVBUILD-IN-BOTS): the bot entrypoint runs a devbuild
// self-check at start — `devbuild 'true'` when DEVBUILD_HOST is set — and
// reports the outcome: one log line plus ${HERMES_HOME}/.myrmidon/
// devbuild-check.json. It must never stop the gateway, must stay silent
// when devbuild is not expected (no DEVBUILD_HOST), and must be skippable
// with MYRMIDON_DEVBUILD_CHECK=0.
//
// These tests source the entrypoint's function by extracting it — the
// entrypoint is a PID-1 script that ends in `exec hermes`, so it cannot be
// sourced whole. Instead we drive the REAL entrypoint through a sandboxed
// PATH where `hermes` and friends are stubs and the function runs for real.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ENTRYPOINT = path.resolve("docker/bot-runtime/entrypoint.sh");

// Extract the devbuild_self_check function body plus the guard line and run
// them in a sandboxed shell with stub `devbuild`, `log`, `json_escape` and a
// scratch HERMES_HOME. This keeps the test honest — it is the same code the
// image runs — without executing the PID-1 tail of the entrypoint.
function extractSelfCheck() {
  const src = readFileSync(ENTRYPOINT, "utf8");
  const start = src.indexOf("devbuild_self_check() {");
  const end = src.indexOf("fi", src.indexOf('MYRMIDON_DEVBUILD_CHECK', start));
  assert.ok(start > 0 && end > start, "devbuild_self_check block found in the entrypoint");
  return src.slice(start, end + 2);
}

function makeSandbox({ devbuildExit = 0, withDevbuild = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "devbuild-selfcheck-"));
  const bin = path.join(root, "bin");
  const hermesHome = path.join(root, "hermes");
  const logFile = path.join(root, "entrypoint.log");
  mkdirSync(bin);
  mkdirSync(hermesHome);
  if (withDevbuild) {
    writeFileSync(
      path.join(bin, "devbuild"),
      `#!/bin/sh\necho "devbuild called with: $@" >> "${logFile}.calls"\nexit ${devbuildExit}\n`,
      { mode: 0o755 },
    );
  }
  const script = `
set -u
PATH="${bin}:/usr/bin:/bin"
HERMES_HOME="${hermesHome}"
log() { echo "$@" >> "${logFile}"; }
json_escape() { printf '%s' "$1" | sed 's/"/\\\\"/g'; }
${extractSelfCheck()}
`;
  return { root, hermesHome, logFile, script };
}

function runSandbox(sb, env) {
  return spawnSync("bash", ["-c", sb.script], { env: { PATH: "/usr/bin:/bin", ...env }, encoding: "utf8" });
}

test("DEVBUILD_HOST unset: the check stays silent, no probe, no report", () => {
  const sb = makeSandbox();
  const r = runSandbox(sb, {});
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(sb.logFile), "nothing logged");
  assert.ok(!existsSync(path.join(sb.hermesHome, ".myrmidon/devbuild-check.json")));
  assert.ok(!existsSync(sb.logFile + ".calls"), "devbuild was not invoked");
});

test("working devbuild: one ok log line and an ok report", () => {
  const sb = makeSandbox({ devbuildExit: 0 });
  const r = runSandbox(sb, { DEVBUILD_HOST: "build.example.invalid", DEVBUILD_USER: "devbuild", DEVBUILD_BASE: "/srv/devbuild" });
  assert.equal(r.status, 0, r.stderr);
  const log = readFileSync(sb.logFile, "utf8");
  assert.match(log, /devbuild self-check ok: devbuild@build\.example\.invalid \/srv\/devbuild/);
  const calls = readFileSync(sb.logFile + ".calls", "utf8");
  assert.match(calls, /devbuild called with: true/);
  const report = JSON.parse(readFileSync(path.join(sb.hermesHome, ".myrmidon/devbuild-check.json"), "utf8"));
  assert.equal(report.ok, true);
  assert.equal(report.host, "build.example.invalid");
  assert.equal(report.error, null);
});

test("broken devbuild: ERROR line, report with the error, shell still exits 0", () => {
  const sb = makeSandbox({ devbuildExit: 1 });
  const r = runSandbox(sb, { DEVBUILD_HOST: "build.example.invalid" });
  assert.equal(r.status, 0, `self-check must never fail the entrypoint: ${r.stderr}`);
  const log = readFileSync(sb.logFile, "utf8");
  assert.match(log, /ERROR: devbuild self-check failed/);
  const report = JSON.parse(readFileSync(path.join(sb.hermesHome, ".myrmidon/devbuild-check.json"), "utf8"));
  assert.equal(report.ok, false);
  assert.equal(typeof report.error, "string");
});

test("DEVBUILD_HOST set but no devbuild binary: clear ERROR, still not fatal", () => {
  const sb = makeSandbox({ withDevbuild: false });
  const r = runSandbox(sb, { DEVBUILD_HOST: "build.example.invalid" });
  assert.equal(r.status, 0);
  const log = readFileSync(sb.logFile, "utf8");
  assert.match(log, /ERROR: devbuild self-check: no devbuild command on PATH/);
});

test("MYRMIDON_DEVBUILD_CHECK=0 disables the probe entirely", () => {
  const sb = makeSandbox();
  const r = runSandbox(sb, { DEVBUILD_HOST: "build.example.invalid", MYRMIDON_DEVBUILD_CHECK: "0" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(sb.logFile), "nothing logged");
  assert.ok(!existsSync(sb.logFile + ".calls"), "devbuild was not invoked");
});
