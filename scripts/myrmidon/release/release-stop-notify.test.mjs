import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// RELEASE-STOP-NOTIFY (OPE-13006): integration tests of the release stop
// notification script. The real release-stop-notify.sh runs against a fake
// `gh` with state files in a sandbox dir; no test touches GitHub. Same
// harness pattern as release-freeze.test.mjs.
//
// Sandbox state:
//   issues.json        existing issues: [{number, title, state}]
// Written by the fake:
//   mutations.log      every issue create/close (one line each)
//   calls.log          every fake gh invocation (verbatim argv)
//   api-failures       counts api list pages answered with exit 1
//   assignments        issue create assignees (see mutations.log)
//   created-url        the URL the fake answers for `gh issue create`
//
// GH_PAGINATE_EOF=y simulates the transient 502/EOF the real --paginate
// hits mid-scan: the api failure is counted, the scan retries, and the
// script still lands on the matching issue.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "release-stop-notify.sh");
const REPO = "itkadr-git/myrmidon";

const FAKE_GH = `#!/usr/bin/env bash
# Fake gh: answers the api scan, lock label creation/deletion, and issue create/close
# of release-stop-notify.sh from files in $SANDBOX; records calls and mutations.
echo "gh $*" >> "$SANDBOX/calls.log"
set -euo pipefail
sub="$1"; shift
case "$sub" in
  api)
    if [ -n "\${GH_SCAN_FAIL:-}" ]; then
      exit 1
    fi
    jq_filter=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --jq) shift; jq_filter="$1" ;;
        -H) shift ;;
        *) ;;
      esac
      shift
    done
    if [ -n "\${GH_PAGINATE_EOF:-}" ] && ! [ -f "$SANDBOX/api-failed-once" ]; then
      touch "$SANDBOX/api-failed-once"
      echo 1 >> "$SANDBOX/api-failures"
      exit 1
    fi
    if [ -n "$jq_filter" ]; then
      jq -r "$jq_filter" "$SANDBOX/issues.json"
    else
      jq -r '.[].title' "$SANDBOX/issues.json"
    fi ;;
  label)
    verb="$1"; shift
    name=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --repo|--description|--color) shift ;;
        --yes) ;;
        -*) ;;
        *) [ -z "$name" ] && name="$1" ;;
      esac
      shift
    done
    case "$verb" in
      create)
        if [ -n "\${GH_LOCK_CREATE_INJECT_ISSUE:-}" ]; then
          jq '. + [{number: 555, title: "release-stop: myr-v1.8.0 (111)", state: "open"}]' "$SANDBOX/issues.json" > "$SANDBOX/issues.json.tmp"
          mv "$SANDBOX/issues.json.tmp" "$SANDBOX/issues.json"
        fi
        if ! mkdir "$SANDBOX/label-$name.lock" 2>/dev/null; then
          echo "label with name \\"$name\\" already exists; use --force to update its color and description" >&2
          exit 1
        fi
        exit 0 ;;
      delete)
        rm -rf "$SANDBOX/label-$name.lock"
        exit 0 ;;
    esac ;;
  issue)
    verb="$1"; shift
    case "$verb" in
      create)
        if [ -n "\${GH_CREATE_FAIL:-}" ]; then
          echo "could not create issue: API rate limit or validation error" >&2
          exit 1
        fi
        title=""; assignees=""; body=""
        while [ "$#" -gt 0 ]; do
          case "$1" in
            --title) shift; title="$1" ;;
            --body) shift; body="$1" ;;
            --assignee) shift; assignees="$assignees $1" ;;
            --repo|--label) shift ;;
            -*) ;;
          esac
          shift
        done
        printf 'create title=%s assignees=%s\\n---body---\\n%s\\n' "$title" "$assignees" "$body" >> "$SANDBOX/mutations.log"
        while ! mkdir "$SANDBOX/issues-file.lock" 2>/dev/null; do
          sleep 0.02
        done
        n=$(( 10#$(jq 'length' "$SANDBOX/issues.json") + 100 ))
        jq --arg t "$title" --argjson n "$n" '. + [{number: $n, title: $t, state: "open"}]' "$SANDBOX/issues.json" > "$SANDBOX/issues.json.tmp"
        mv "$SANDBOX/issues.json.tmp" "$SANDBOX/issues.json"
        rmdir "$SANDBOX/issues-file.lock"
        printf 'https://github.com/x/y/issues/%s\\n' "$n" ;;
      close)
        num="$1"; shift
        printf 'close issue=%s\\n' "$num" >> "$SANDBOX/mutations.log"
        while ! mkdir "$SANDBOX/issues-file.lock" 2>/dev/null; do
          sleep 0.02
        done
        jq --argjson n "$num" 'map(if .number == $n then .state = "closed" else . end)' "$SANDBOX/issues.json" > "$SANDBOX/issues.json.tmp"
        mv "$SANDBOX/issues.json.tmp" "$SANDBOX/issues.json"
        rmdir "$SANDBOX/issues-file.lock"
        exit 0 ;;
    esac ;;
esac
`;

function writeJson(dir, name, value) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
}

function makeSandbox(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-stop-notify-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "gh"), FAKE_GH, { mode: 0o755 });
  writeJson(dir, "issues.json", opts.issues ?? []);
  return { dir, bin };
}

function runScript(sandbox, extraEnv = {}) {
  return spawnSync("bash", [SCRIPT], {
    env: {
      ...process.env,
      BASH_ENV: "",
      SANDBOX: sandbox.dir,
      PATH: `${sandbox.bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY: REPO,
      GITHUB_TOKEN: "test-token",
      GH_RELEASE_TOKEN: "",
      RELEASE_TAG: "myr-v1.8.0",
      RELEASE_STEP: "publish",
      RELEASE_STOP_REASON: "the publish job failed (CI gate, npm publish, or visibility poll)",
      RELEASE_STOP_EVENT_ID: "111",
      RELEASE_RESPONSIBLE_LOGIN: "kadr",
      RELEASE_STOP_LOOKUP_RETRY_DELAY: "0.1",
      RELEASE_STOP_LOCK_POLL_DELAY: "0.1",
      ...extraEnv,
    },
    encoding: "utf8",
  });
}

function runScriptAsync(sandbox, extraEnv = {}) {
  return new Promise((resolve) => {
    const proc = spawn("bash", [SCRIPT], {
      env: {
        ...process.env,
        BASH_ENV: "",
        SANDBOX: sandbox.dir,
        PATH: `${sandbox.bin}:${process.env.PATH}`,
        GITHUB_REPOSITORY: REPO,
        GITHUB_TOKEN: "test-token",
        GH_RELEASE_TOKEN: "",
        RELEASE_TAG: "myr-v1.8.0",
        RELEASE_STEP: "publish",
        RELEASE_STOP_REASON: "the publish job failed (CI gate, npm publish, or visibility poll)",
        RELEASE_STOP_EVENT_ID: "111",
        RELEASE_RESPONSIBLE_LOGIN: "kadr",
        RELEASE_STOP_LOOKUP_RETRY_DELAY: "0.05",
        RELEASE_STOP_LOCK_POLL_DELAY: "0.05",
        ...extraEnv,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

describe("release-stop-notify.sh (fake gh)", () => {
  it("creates one assigned entry with step, reason, step link, and responsible visible in the body", () => {
    const sb = makeSandbox();
    const r = runScript(sb);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /stop=created/);
    assert.match(r.stdout, /event=111/);
    const mutations = fs.readFileSync(path.join(sb.dir, "mutations.log"), "utf8");
    assert.match(mutations, /release-stop: myr-v1\.8\.0 \(111\)/);
    assert.match(mutations, /assignees= kadr/);
    assert.match(mutations, /Step: `publish`/);
    assert.match(mutations, /Reason: the publish job failed/);
    assert.match(mutations, /Step link: https:\/\/github\.com\/itkadr-git\/myrmidon\/actions\/runs\/111/);
    assert.match(mutations, /@kadr/);
    const issues = JSON.parse(fs.readFileSync(path.join(sb.dir, "issues.json"), "utf8"));
    assert.equal(issues.length, 1);
  });

  it("fails closed when the responsible login is missing (no unassigned delivery)", () => {
    const sb = makeSandbox();
    const r = runScript(sb, { RELEASE_RESPONSIBLE_LOGIN: "" });
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /RELEASE_RESPONSIBLE_LOGIN/);
    assert.ok(!fs.existsSync(path.join(sb.dir, "mutations.log")), "no issue create must happen");
  });

  it("does not duplicate the entry when the stop event already notified (retry of the same run)", () => {
    const sb = makeSandbox({
      issues: [{ number: 7, title: "release-stop: myr-v1.8.0 (111)", state: "open" }],
    });
    const r = runScript(sb);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /stop=deduplicated issue=7 event=111/);
    assert.ok(!fs.existsSync(path.join(sb.dir, "mutations.log")), "no issue create must happen");
  });

  it("dedupe finds the entry beyond the first page (pagination is followed)", () => {
    const old = [];
    for (let i = 0; i < 150; i += 1) {
      old.push({ number: i + 1, title: `chore: filler ${i}`, state: "closed" });
    }
    old.push({ number: 999, title: "release-stop: myr-v1.8.0 (111)", state: "closed" });
    const sb = makeSandbox({ issues: old });
    const r = runScript(sb);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /stop=deduplicated issue=999 event=111/);
    assert.ok(!fs.existsSync(path.join(sb.dir, "mutations.log")));
    const calls = fs.readFileSync(path.join(sb.dir, "calls.log"), "utf8");
    assert.match(calls, /--paginate/);
  });

  it("dedupe survives a transient api failure mid-scan (the lookup retries)", () => {
    const sb = makeSandbox({
      issues: [{ number: 7, title: "release-stop: myr-v1.8.0 (111)", state: "open" }],
    });
    const r = runScript(sb, { GH_PAGINATE_EOF: "y" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /stop=deduplicated issue=7/);
    assert.ok(!fs.existsSync(path.join(sb.dir, "mutations.log")));
    const failures = fs.readFileSync(path.join(sb.dir, "api-failures"), "utf8").trim();
    assert.equal(failures, "1");
    const calls = fs.readFileSync(path.join(sb.dir, "calls.log"), "utf8").trim().split("\n");
    const apiCalls = calls.filter((c) => c.includes(" api "));
    assert.ok(apiCalls.length >= 2, `expected the api scan to retry, got: ${calls.join(" | ")}`);
  });

  it("a closed entry still suppresses the re-send for the same stop event", () => {
    const sb = makeSandbox({
      issues: [{ number: 8, title: "release-stop: myr-v1.8.0 (111)", state: "closed" }],
    });
    const r = runScript(sb);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /stop=deduplicated issue=8/);
    assert.ok(!fs.existsSync(path.join(sb.dir, "mutations.log")));
  });

  it("a fresh workflow run of the same tag is a new stop event and notifies again", () => {
    const sb = makeSandbox({
      issues: [{ number: 7, title: "release-stop: myr-v1.8.0 (111)", state: "open" }],
    });
    const r = runScript(sb, { RELEASE_STOP_EVENT_ID: "222" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /stop=created/);
    assert.match(r.stdout, /event=222/);
    const mutations = fs.readFileSync(path.join(sb.dir, "mutations.log"), "utf8");
    assert.match(mutations, /release-stop: myr-v1\.8\.0 \(222\)/);
  });

  it("a different step on a different run opens its own entry", () => {
    const sb = makeSandbox({
      issues: [{ number: 7, title: "release-stop: myr-v1.8.0 (111)", state: "open" }],
    });
    const r = runScript(sb, { RELEASE_STOP_EVENT_ID: "333", RELEASE_STEP: "docker" });
    assert.equal(r.status, 0, r.stderr);
    const mutations = fs.readFileSync(path.join(sb.dir, "mutations.log"), "utf8");
    assert.match(mutations, /release-stop: myr-v1\.8\.0 \(333\)/);
    assert.match(mutations, /Step: `docker`/);
  });

  it("fails closed when the required inputs are missing", () => {
    const sb = makeSandbox();
    const r = runScript(sb, { RELEASE_STOP_EVENT_ID: "", GITHUB_RUN_ID: "" });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /RELEASE_STOP_EVENT_ID/);
    assert.ok(!fs.existsSync(path.join(sb.dir, "mutations.log")));
  });

  it("fails closed when duplicate scan fails (scan errors, nothing is silently created)", () => {
    const sb = makeSandbox();
    const r = runScript(sb, { GH_SCAN_FAIL: "y", RELEASE_STOP_LOOKUP_RETRY_DELAY: "0" });
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /the duplicate scan failed/);
    assert.ok(!fs.existsSync(path.join(sb.dir, "mutations.log")), "no issue create must happen");
    const calls = fs.readFileSync(path.join(sb.dir, "calls.log"), "utf8");
    assert.doesNotMatch(calls, /issue create/);
  });

  it("fails closed when issue delivery fails (create errors, failure is surfaced)", () => {
    const sb = makeSandbox();
    const r = runScript(sb, { GH_CREATE_FAIL: "y", RELEASE_STOP_LOOKUP_RETRY_DELAY: "0" });
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /could not create the stop notification issue/);
    const calls = fs.readFileSync(path.join(sb.dir, "calls.log"), "utf8");
    assert.match(calls, /issue create/);
    const issues = JSON.parse(fs.readFileSync(path.join(sb.dir, "issues.json"), "utf8"));
    assert.equal(issues.length, 0, "no issue must be stored on create failure");
  });

  it("deduplicates concurrent executions for the same stop event without duplicate issue creation (overlap)", async () => {
    const sb = makeSandbox();
    const [r1, r2] = await Promise.all([
      runScriptAsync(sb),
      runScriptAsync(sb),
    ]);
    assert.equal(r1.status, 0, `p1 failed: ${r1.stderr}`);
    assert.equal(r2.status, 0, `p2 failed: ${r2.stderr}`);
    const outputs = [r1.stdout, r2.stdout].join("\n");
    assert.match(outputs, /stop=created issue=https:\/\/github\.com\/x\/y\/issues\/100 event=111/);
    assert.match(outputs, /stop=deduplicated issue=100 event=111/);
    const issues = JSON.parse(fs.readFileSync(path.join(sb.dir, "issues.json"), "utf8"));
    const matchingIssues = issues.filter((it) => it.title === "release-stop: myr-v1.8.0 (111)");
    assert.equal(matchingIssues.length, 1, `expected exactly 1 matching issue, got: ${JSON.stringify(issues)}`);
    assert.equal(matchingIssues[0].state, "open");
  });

  it("rescans after acquiring lock when another run created the issue and released the lock", () => {
    const sb = makeSandbox();
    const r = runScript(sb, { GH_LOCK_CREATE_INJECT_ISSUE: "y" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /stop=deduplicated issue=555 event=111/);
    assert.ok(!fs.existsSync(path.join(sb.dir, "mutations.log")), "no issue create must happen when rescan finds an existing issue");
    const issues = JSON.parse(fs.readFileSync(path.join(sb.dir, "issues.json"), "utf8"));
    assert.equal(issues.length, 1);
    assert.equal(issues[0].number, 555);
  });

  it("the workflow serializes notification retries per stop event (concurrency group)", () => {
    const yml = fs.readFileSync(
      path.join(HERE, "..", "..", "..", ".github", "workflows", "myrmidon-release-stop-notify.yml"),
      "utf8",
    );
    assert.match(yml, /concurrency:\s*\n\s*group: release-stop-notify-\$\{\{ github\.event\.workflow_run\.id \}\}/);
    assert.match(yml, /cancel-in-progress: false/);
  });
});
