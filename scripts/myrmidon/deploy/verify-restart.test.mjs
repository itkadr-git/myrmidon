import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// verify-restart.sh — the post-restart health gate of the update executor
// (OPE-12088, 1.7 AUTO-UPDATE-ROLLBACK). Runs the real script against a fake
// `curl` first in PATH: success (status ok), failure (service up but wrong
// status) and service-never-answers (curl fails every attempt). No test
// touches a real service or board.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "verify-restart.sh");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const VERSION = "2026.1109.1-myr.1";

// The fake curl: serves $SANDBOX/health.json (body) with $SANDBOX/health-code
// (HTTP status, default 200). Non-200 codes make curl -f exit non-zero — the
// "service not answering" path. Every call is logged for the assertion that
// the gate really retried.
//
// The test intentionally creates the executable wrapper below in /tmp, then
// runs it through bash: this worker mounts both /bot and /tmp noexec.
const FAKE_CURL = `#!/usr/bin/env bash
echo "curl $*" >> "$SANDBOX/calls.log"
# curl-mode=fail: the service never answers (connection refused/timeout path).
if [ -e "$SANDBOX/curl-mode" ] && [ "$(cat "$SANDBOX/curl-mode")" = "fail" ]; then
  echo "curl: (7) Failed to connect" >&2
  exit 7
fi
case " $* " in
  *"--write-out"*|*"-w "*)
    # caller asks for the status code only (lib.sh helpers)
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-verify-restart-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  // The workspace mount is noexec (the fake curl file itself must not be
  // executed directly), so the PATH entry is a wrapper that `bash`es the
  // sandboxed fake — the same trick deploy.test.mjs uses.
  fs.writeFileSync(path.join(bin, "curl"), `#!/usr/bin/env bash\nexec "${process.env.PATH.split(":").map((d) => path.join(d, "bash")).find((f) => fs.existsSync(f))}" "${path.join(dir, "fake-curl.sh")}" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "fake-curl.sh"), FAKE_CURL);
  fs.writeFileSync(path.join(dir, "calls.log"), "");
  fs.writeFileSync(path.join(dir, "health.json"), JSON.stringify(health ?? { status: "ok", version: VERSION, commit: COMMIT }));
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
    ].join("\n"),
  );
  return { dir, bin, config };
}

function run(sb, args) {
  const bash = process.env.PATH.split(":").map((d) => path.join(d, "bash")).find((f) => fs.existsSync(f));
  const result = spawnSync(bash, [SCRIPT, "--config", sb.config, ...args], {
    env: { ...process.env, PATH: `${sb.bin}:${process.env.PATH}`, SANDBOX: sb.dir },
    encoding: "utf8",
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
const history = (sb) => read(path.join(sb.dir, "state", "history.log"));
const calls = (sb) => read(path.join(sb.dir, "calls.log"));

describe("verify-restart.sh", () => {
  it("passes when the restarted service reports status ok", () => {
    const sb = sandbox();
    const { code, out } = run(sb, []);
    assert.equal(code, 0, out);
    assert.match(out, /status ok/);
    // One answered attempt is enough: no second probe after success.
    assert.equal(calls(sb).split("\n").filter((l) => l.includes("api/health")).length, 1);
    // The update log records the successful health event too.
    assert.match(history(sb), /health-check:ok/);
  });

  it("fails with exit 2 when the service answers with a wrong status", () => {
    const sb = sandbox({ health: { status: "starting" } });
    const { code, out } = run(sb, ["--retries", "3"]);
    assert.equal(code, 2, out);
    // Polled up to --retries times before giving up.
    assert.ok(calls(sb).split("\n").filter((l) => l.includes("api/health")).length >= 3, calls(sb));
    assert.match(out, /health FAILED after 3 attempts/);
    // The failure is recorded in the update log for the orchestrator.
    assert.match(history(sb), /health-check:failed/);
    assert.match(history(sb), /status is 'starting'/);
  });

  it("fails with exit 2 when the service never answers (curl fails every attempt)", () => {
    // curl itself failing (connection refused / timeout) is the same verdict
    // as a wrong status: the gate records every failed attempt in the update
    // log and reports exit 2 for the orchestrator.
    const sb = sandbox({ health: {} });
    fs.writeFileSync(path.join(sb.dir, "curl-mode"), "fail");
    const { code, out } = run(sb, ["--retries", "2"]);
    assert.equal(code, 2, out);
    assert.ok(calls(sb).split("\n").filter((l) => l.includes("api/health")).length >= 2, calls(sb));
    assert.match(history(sb), /curl failed/);
    assert.match(history(sb), /health FAILED after 2 attempts/);
  });

  it("recovers when the service starts answering before the retries run out", () => {
    // The restart is asynchronous: the first probes fail while the service is
    // coming up, a later one must pass without the gate giving up.
    const sb = sandbox();
    fs.writeFileSync(path.join(sb.dir, "curl-mode"), "fail-once");
    const flip = `#!/usr/bin/env bash
echo "curl $*" >> "$SANDBOX/calls.log"
if [ -e "$SANDBOX/curl-mode" ]; then rm "$SANDBOX/curl-mode"; exit 7; fi
cat "$SANDBOX/health.json"
`;
    fs.writeFileSync(path.join(sb.dir, "fake-curl.sh"), flip);
    const { code, out } = run(sb, ["--retries", "5", "--interval", "0"]);
    assert.equal(code, 0, out);
    assert.ok(calls(sb).split("\n").filter((l) => l.includes("api/health")).length >= 2, calls(sb));
    assert.match(history(sb), /health-check:ok/);
  });

  it("checks the image revision when --digest is given", () => {
    const sb = sandbox({ health: { status: "ok", version: VERSION, commit: "ffffffffffffffffffffffffffffffffffffffff" } });
    const { code, out } = run(sb, ["--digest", COMMIT, "--retries", "2"]);
    assert.equal(code, 2, out);
    assert.match(out, /wrong revision/);
    assert.match(history(sb), /wrong revision/);
  });

  it("misconfiguration exits 3 without polling", () => {
    const sb = sandbox();
    // HEALTH_RETRIES in the config replaces the default retry count (a
    // --retries flag would win): a non-numeric value must be refused BEFORE
    // the first probe, with the misconfiguration exit code.
    fs.writeFileSync(sb.config, `HEALTH_URL=http://127.0.0.1:3100/api/health\nHEALTH_RETRIES=many\n`);
    const { code, out } = run(sb, []);
    assert.equal(code, 3, out);
    assert.match(out, /--retries must be a positive integer/);
    assert.equal(calls(sb), "");
  });

  it("works without a config when --url is given (journal events are then skipped)", () => {
    const sb = sandbox();
    const bash = process.env.PATH.split(":").map((d) => path.join(d, "bash")).find((f) => fs.existsSync(f));
    const proc = spawnSync(bash, [SCRIPT, "--url", "http://127.0.0.1:3100/api/health", "--retries", "2"], {
      env: { ...process.env, PATH: `${sb.bin}:${process.env.PATH}`, SANDBOX: sb.dir },
      encoding: "utf8",
    });
    assert.equal(proc.status, 0, `${proc.stdout}${proc.stderr}`);
    // No STATE_DIR was configured: the journal is skipped, the verdict lives
    // on stdout only.
    assert.equal(fs.existsSync(path.join(sb.dir, "state")), false);
  });
});
