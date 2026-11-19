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
trace() { printf '%s pid=%s %s\\n' "$(date +%s.%N)" "$$" "$*" >> "$SANDBOX/trace.log"; }
trace "begin $*"
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
    # Listing-lag emulation (test-only, deterministic): while lag-listing.json
    # exists, the listing endpoint serves that frozen snapshot instead of the
    # live file. This emulates the real GitHub behavior the production script
    # is designed around: a list query can be answered by a replica that has
    # not yet absorbed a just-created issue. issue create clears the lag (the
    # mutating write is fresh on the primary); see the self-heal test.
    if [ -f "$SANDBOX/lag-listing.json" ]; then
      if [ -n "$jq_filter" ]; then
        result="$(jq -r "$jq_filter" "$SANDBOX/lag-listing.json")" || exit 1
      else
        result="$(jq -r '.[].title' "$SANDBOX/lag-listing.json")" || exit 1
      fi
      trace "scan result(lagged)=$result"
      printf '%s\\n' "$result"
      exit 0
    fi
    # Serialize reads with the issue create/close writes below: a scan that
    # races a concurrent create must observe the fully written issue, never
    # a transient (pre-write) state. Without this lock a listing read whose
    # open() lands before a concurrent create's rename reads the pre-write
    # inode (a stale snapshot), the only torn-read hazard a local file has.
    while ! mkdir "$SANDBOX/issues-file.lock" 2>/dev/null; do
      trace "api waiting for issues lock"
      sleep 0.01
    done
    if [ -n "$jq_filter" ]; then
      result="$(jq -r "$jq_filter" "$SANDBOX/issues.json")" || { rmdir "$SANDBOX/issues-file.lock"; exit 1; }
    else
      result="$(jq -r '.[].title' "$SANDBOX/issues.json")" || { rmdir "$SANDBOX/issues-file.lock"; exit 1; }
    fi
    rmdir "$SANDBOX/issues-file.lock"
    trace "scan result=$result"
    printf '%s\\n' "$result" ;;
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
          trace "lock busy $name"
          echo "label with name \\"$name\\" already exists; use --force to update its color and description" >&2
          exit 1
        fi
        trace "lock acquired $name"
        exit 0 ;;
      delete)
        trace "lock deleting $name"
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
        # The create path is served by the primary: from here on, listing reads
        # observe the new issue (clears the listing-lag emulation).
        rm -f "$SANDBOX/lag-listing.json"
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
    assert.equal(matchingIssues.length, 1, `expected exactly 1 matching issue, got: ${JSON.stringify(issues)}\n${fs.readFileSync(path.join(sb.dir, "trace.log"), "utf8")}\np1: ${r1.stderr}\np2: ${r2.stderr}`);
    assert.equal(matchingIssues[0].state, "open");
  });

  // Fixture-fidelity proof (deterministic, no wall-clock): the production
  // contract requires a listing read to observe every COMPLETED write. On a
  // local file the only way to violate that is a torn read: the reader's
  // open() lands before a concurrent create's rename and its read() executes
  // after it, returning the pre-write inode (a stale snapshot). The old fake
  // api handler read issues.json without the issues-file.lock the create and
  // close handlers hold, so nothing prevented that window. The fix makes the
  // listing read take the same lock, which moves the open() strictly after
  // the writer's rename. This test is a pure event handshake: the test
  // process holds the lock (as an in-flight create would), starts a scan,
  // waits until the fake handler observably reports it is waiting on that
  // lock, asserts the scan stays blocked, then publishes the fully written
  // issue and releases the lock. The scan must observe the published issue.
  it("fake gh api scan is serialized with a concurrent issue write (deterministic interleaving)", async () => {
    const sb = makeSandbox();
    const lockDir = path.join(sb.dir, "issues-file.lock");
    const traceFile = path.join(sb.dir, "trace.log");
    // Writer half of the handshake: hold the lock exactly like an in-flight
    // create, and publish the issue only after the scan is observably blocked.
    fs.mkdirSync(lockDir);
    const scan = spawn("gh", [
      "api", "--paginate",
      "-H", "Accept: application/vnd.github+json",
      `/repos/${REPO}/issues?state=all&per_page=100`,
      "--jq", '.[] | select(.title == "written") | .number',
    ], {
      env: { ...process.env, SANDBOX: sb.dir, PATH: `${sb.bin}:${process.env.PATH}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    scan.stdout.on("data", (chunk) => { stdout += chunk; });
    scan.stderr.on("data", (chunk) => { stderr += chunk; });
    const closed = new Promise((resolve) => scan.on("close", (code) => resolve(code)));
    try {
      const readTrace = () => (fs.existsSync(traceFile) ? fs.readFileSync(traceFile, "utf8") : "");
      // Wait (bounded) until the fake handler observably reports it is
      // waiting on the issues lock. A scan that does not serialize reads
      // with writes never waits: it reads the pre-write file and exits, so
      // this assertion fails deterministically.
      const deadline = Date.now() + 5000;
      while (!readTrace().includes("api waiting for issues lock")) {
        if (scan.exitCode !== null) break;
        if (Date.now() > deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.ok(
        readTrace().includes("api waiting for issues lock"),
        `scan never waited on the issues lock; it read the pre-write snapshot and raced ahead. stderr: ${stderr}`,
      );
      assert.equal(scan.exitCode, null, "scan must stay blocked while the lock is held");
      // Publish the fully written issue, then release the lock.
      fs.writeFileSync(path.join(sb.dir, "issues.json"), '[{"number":7,"title":"written","state":"open"}]');
      fs.rmdirSync(lockDir);
      const status = await closed;
      assert.equal(status, 0, stderr);
      assert.match(stdout, /^7/, `scan must observe the fully written issue, got: ${JSON.stringify(stdout)}`);
    } finally {
      if (fs.existsSync(lockDir)) fs.rmdirSync(lockDir);
      if (scan.exitCode === null) scan.kill();
      await closed;
    }
  });

  // Deterministic reproduction of the observed "open #100 + closed #101" pair
  // (runs 43779902791 and 44507283140) through TWO REAL release-stop-notify.sh
  // runs. The production script is explicitly designed for a listing that lags
  // a just-created issue ("if concurrent creations ever race past the lock,
  // any duplicate is immediately closed in favor of the canonical lowest issue
  // number"). That lag at the label-lock handover is the one interleaving that
  // yields the pair:
  //   1. Run A completes: creates #100 (canonical), releases the label lock.
  //   2. Run B starts while a listing replica still serves the pre-A view.
  //      B's initial scan and its rescan-after-lock-acquire both miss #100.
  //   3. B creates #101. B's post-creation scan (fresh, write path) sees both
  //      entries and closes #101 in favor of canonical #100.
  // End state: exactly one OPEN journal entry plus the self-healed closed
  // duplicate — the pair from CI. The fake emulates the lag deterministically
  // via the lag-listing.json snapshot (armed by the test, cleared by the
  // create handler); no sleeps, no wall-clock assertions.
  it("two real runs under a listing lag at the lock handover reproduce the observed pair and self-heal to one open entry", () => {
    const sbA = makeSandbox();
    const ra = runScript(sbA);
    assert.equal(ra.status, 0, ra.stderr);
    assert.match(ra.stdout, /stop=created issue=https:\/\/github\.com\/x\/y\/issues\/100 event=111/);
    // Fresh sandbox holding A's published state; arm the lagged listing (the
    // replica view from before A's create) before B starts.
    const sb = makeSandbox({ issues: JSON.parse(fs.readFileSync(path.join(sbA.dir, "issues.json"), "utf8")) });
    fs.writeFileSync(path.join(sb.dir, "lag-listing.json"), "[]");
    const rb = runScript(sb);
    assert.equal(rb.status, 0, rb.stderr);
    assert.match(rb.stdout, /stop=deduplicated issue=100 event=111/);
    const issues = JSON.parse(fs.readFileSync(path.join(sb.dir, "issues.json"), "utf8"));
    const matching = issues.filter((it) => it.title === "release-stop: myr-v1.8.0 (111)");
    assert.deepEqual(
      matching.map((m) => `${m.number}:${m.state}`).sort(),
      ["100:open", "101:closed"],
      `expected the observed self-healed pair, got: ${JSON.stringify(issues)}`,
    );
    const mutations = fs.readFileSync(path.join(sb.dir, "mutations.log"), "utf8");
    assert.match(mutations, /create title=release-stop: myr-v1\.8\.0 \(111\)/);
    assert.match(mutations, /close issue=101/, "the duplicate must be closed by the post-creation self-heal");
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
