import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// update.test.mjs — Integration tests for scripts/update
// (OPE-12088, 1.7 AUTO-UPDATE-ROLLBACK).
// Verifies that scripts/update performs service restart, runs the post-restart
// health gate, records events into the update log, and returns a nonzero exit code
// on health failure so the orchestrator can trigger auto-rollback.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const UPDATE_SCRIPT = path.join(REPO_ROOT, "scripts", "update");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const VERSION = "2026.1109.1-myr.1";

const FAKE_CURL = `#!/usr/bin/env bash
echo "curl $*" >> "$SANDBOX/calls.log"
if [ -e "$SANDBOX/curl-mode" ] && [ "$(cat "$SANDBOX/curl-mode")" = "fail" ]; then
  echo "curl: (7) Failed to connect" >&2
  exit 7
fi
case " $* " in
  *"--write-out"*|*"-w "*)
    code=200
    [ -e "$SANDBOX/health-code" ] && code=$(cat "$SANDBOX/health-code")
    printf '%s' "$code"
    exit 0 ;;
esac
body=$(cat "$SANDBOX/health.json" 2>/dev/null || echo '')
code=$(cat "$SANDBOX/health-code" 2>/dev/null || echo 200)
if [ "$code" != "200" ]; then
  echo "curl: HTTP $code" >&2
  exit 22
fi
printf '%s' "$body"
`;

function sandbox({ health, code } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-update-test-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);

  const bashPath = process.env.PATH.split(":").map((d) => path.join(d, "bash")).find((f) => fs.existsSync(f));
  fs.writeFileSync(
    path.join(bin, "curl"),
    `#!/usr/bin/env bash\nexec "${bashPath}" "${path.join(dir, "fake-curl.sh")}" "$@"\n`,
    { mode: 0o755 }
  );
  fs.writeFileSync(path.join(dir, "fake-curl.sh"), FAKE_CURL);
  fs.writeFileSync(path.join(dir, "calls.log"), "");
  fs.writeFileSync(
    path.join(dir, "health.json"),
    JSON.stringify(health ?? { status: "ok", version: VERSION, commit: COMMIT })
  );
  if (code !== undefined) fs.writeFileSync(path.join(dir, "health-code"), String(code));

  const config = path.join(dir, "deploy.env");
  fs.writeFileSync(
    config,
    [
      `HEALTH_URL=http://127.0.0.1:3100/api/health`,
      `POLL_INTERVAL_SEC=0`,
      `HEALTH_TIMEOUT_SEC=2`,
      `STATE_DIR=${path.join(dir, "state")}`,
      "",
    ].join("\n")
  );

  return { dir, bin, config, logFile: path.join(dir, "update.log") };
}

function run(sb, args) {
  const bash = process.env.PATH.split(":").map((d) => path.join(d, "bash")).find((f) => fs.existsSync(f));
  const result = spawnSync(bash, [UPDATE_SCRIPT, "--config", sb.config, "--log-file", sb.logFile, ...args], {
    env: { ...process.env, BASH_ENV: "", ENV: "", PATH: `${sb.bin}:${process.env.PATH}`, SANDBOX: sb.dir },
    encoding: "utf8",
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");

describe("scripts/update", () => {
  it("executes service restart and passes health check on success", () => {
    const sb = sandbox();
    const restartMarker = path.join(sb.dir, "restarted.txt");
    const { code, out } = run(sb, [
      "--restart-cmd",
      `echo restarted > "${restartMarker}"`,
      "--retries",
      "3",
    ]);

    assert.equal(code, 0, out);
    assert.match(out, /Step 1: restarting service/);
    assert.match(out, /SUCCESS: post-restart health check passed/);
    assert.equal(read(restartMarker).trim(), "restarted");

    const logContent = read(sb.logFile);
    assert.match(logContent, /update:restart/);
    assert.match(logContent, /update:health-check:ok/);
  });

  it("fails and propagates nonzero exit code when health check fails (wrong status)", () => {
    const sb = sandbox({ health: { status: "failing" } });
    const restartMarker = path.join(sb.dir, "restarted.txt");
    const { code, out } = run(sb, [
      "--restart-cmd",
      `echo restarted > "${restartMarker}"`,
      "--retries",
      "2",
    ]);

    assert.notEqual(code, 0, out);
    assert.equal(code, 2, "must propagate exit code 2 from verify-restart");
    assert.match(out, /signaling auto-rollback/);
    assert.equal(read(restartMarker).trim(), "restarted");

    const logContent = read(sb.logFile);
    assert.match(logContent, /update:restart/);
    assert.match(logContent, /update:health-check:failed/);
    const probeCalls = read(path.join(sb.dir, "calls.log")).split("\n").filter((l) => l.includes("api/health"));
    assert.equal(probeCalls.length, 2, "must poll endpoint exactly --retries times on persistent failure");
  });

  it("fails and propagates nonzero exit code when health endpoint is unreachable (curl fails)", () => {
    const sb = sandbox();
    fs.writeFileSync(path.join(sb.dir, "curl-mode"), "fail");
    const { code, out } = run(sb, [
      "--restart-cmd",
      "true",
      "--retries",
      "2",
    ]);

    assert.equal(code, 2, "must propagate exit code 2 when curl fails all attempts");
    assert.match(out, /signaling auto-rollback/);

    const logContent = read(sb.logFile);
    assert.match(logContent, /update:health-check:failed/);
    const probeCalls = read(path.join(sb.dir, "calls.log")).split("\n").filter((l) => l.includes("curl "));
    assert.equal(probeCalls.length, 2, "must poll endpoint exactly --retries times when curl fails");
  });

  it("polls up to 5 times by default when retries argument is omitted", () => {
    const sb = sandbox({ health: { status: "not_ready" } });
    const { code, out } = run(sb, [
      "--restart-cmd",
      "true",
    ]);

    assert.equal(code, 2);
    assert.match(out, /health FAILED after 5 attempts/);
    const logContent = read(sb.logFile);
    assert.match(logContent, /update:health-check:failed/);
    const probeCalls = read(path.join(sb.dir, "calls.log")).split("\n").filter((l) => l.includes("api/health"));
    assert.equal(probeCalls.length, 5, "must poll 5 times by default");
  });

  it("aborts before health check if restart command fails", () => {
    const sb = sandbox();
    const { code, out } = run(sb, [
      "--restart-cmd",
      "false",
      "--retries",
      "3",
    ]);

    assert.equal(code, 1, out);
    assert.match(out, /service restart command failed/);

    const logContent = read(sb.logFile);
    assert.match(logContent, /update:restart:failed/);
    assert.doesNotMatch(logContent, /update:health-check:starting/);
  });
});
