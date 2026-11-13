import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
//   mutations.log      every issue create (one line each: title + assignees)
//   created-url        the URL the fake answers for `gh issue create`

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "release-stop-notify.sh");
const REPO = "itkadr-git/myrmidon";

const FAKE_GH = `#!/usr/bin/env bash
# Fake gh: answers the issue list/create calls of release-stop-notify.sh from
# files in $SANDBOX; records mutations into mutations.log.
echo "gh $*" >> "$SANDBOX/calls.log"
set -euo pipefail
sub="$1"; shift
case "$sub" in
  issue)
    verb="$1"; shift
    jq_filter=""; title=""; assignees=""; body=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --jq) shift; jq_filter="$1" ;;
        --title) shift; title="$1" ;;
        --assignee) shift; assignees="$assignees $1" ;;
        --body) shift; body="$1" ;;
        --repo|--state|--limit|--json|--label) shift ;;
        -*) ;;
      esac
      shift
    done
    case "$verb" in
      list)
        if [ -n "$jq_filter" ]; then
          jq -r "$jq_filter" "$SANDBOX/issues.json"
        else
          cat "$SANDBOX/issues.json"
        fi ;;
      create)
        printf 'create title=%s assignees=%s body=%s\\n' "$title" "$assignees" "$body" >> "$SANDBOX/mutations.log"
        n=$(( 10#$(jq 'length' "$SANDBOX/issues.json") + 100 ))
        jq --arg t "$title" --argjson n "$n" '. + [{number: $n, title: $t, state: "open"}]' "$SANDBOX/issues.json" > "$SANDBOX/issues.json.tmp"
        mv "$SANDBOX/issues.json.tmp" "$SANDBOX/issues.json"
        printf 'https://github.com/x/y/issues/%s\\n' "$n" ;;
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
      RELEASE_RESPONSIBLE_LOGIN: "",
      ...extraEnv,
    },
    encoding: "utf8",
  });
}

describe("release-stop-notify.sh (fake gh)", () => {
  it("creates one assigned entry with step and reason visible in the body", () => {
    const sb = makeSandbox();
    const r = runScript(sb, { RELEASE_RESPONSIBLE_LOGIN: "kadr" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /stop=created/);
    assert.match(r.stdout, /event=111/);
    const mutations = fs.readFileSync(path.join(sb.dir, "mutations.log"), "utf8");
    assert.match(mutations, /release-stop: myr-v1\.8\.0 \(111\)/);
    assert.match(mutations, /assignees= kadr/);
    const mutationsWithBody = fs.readFileSync(path.join(sb.dir, "mutations.log"), "utf8");
    assert.match(mutationsWithBody, /Step link: https:\/\/github.com\/itkadr-git\/myrmidon\/actions\/runs\/111/);
    const issues = JSON.parse(fs.readFileSync(path.join(sb.dir, "issues.json"), "utf8"));
    assert.equal(issues.length, 1);
  });

  it("creates without an assignee when the responsible login is unset", () => {
  const sb = makeSandbox();
  const r = runScript(sb);
  assert.equal(r.status, 0, r.stderr);
  const mutations = fs.readFileSync(path.join(sb.dir, "mutations.log"), "utf8");
  assert.doesNotMatch(mutations, /assignees=\S/);
  });

  it("does not duplicate the entry when the stop event already notified (retry of the same run)", () => {
    const sb = makeSandbox({
      issues: [{ number: 7, title: "release-stop: myr-v1.8.0 (111)", state: "open" }],
    });
    const r = runScript(sb, { RELEASE_RESPONSIBLE_LOGIN: "kadr" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /stop=deduplicated issue=7 event=111/);
    assert.ok(!fs.existsSync(path.join(sb.dir, "mutations.log")), "no issue create must happen");
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
  });

  it("fails closed when the required inputs are missing", () => {
    const sb = makeSandbox();
    const r = runScript(sb, { RELEASE_STOP_EVENT_ID: "", GITHUB_RUN_ID: "" });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /RELEASE_STOP_EVENT_ID/);
    assert.ok(!fs.existsSync(path.join(sb.dir, "mutations.log")));
  });
});
