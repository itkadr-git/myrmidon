import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// RELEASE-FREEZE (the 1.6.4 incident): integration tests of the release
// freeze gate script. The real release-freeze.sh runs against a fake `gh`
// (and a real `jq`) with state files in a sandbox dir; no test touches
// GitHub. Same harness pattern as release-publish.test.mjs.
//
// Sandbox state:
//   refs-tags.json     answer to GET repos/<repo>/git/refs/tags (array of refs)
//   ref-tag.json       answer to GET repos/<repo>/git/ref/tags/<tag>
//   tag-object.json    answer to GET repos/<repo>/git/tags/<object> (annotated)
//   runs.json          answer to GET repos/<repo>/actions/runs?head_sha=…
//   issues.json        open issues: [{number, title}]
// Written by the fake:
//   mutations.log      every issue create/close (one line each)

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "release-freeze.sh");
const REPO = "itkadr-git/myrmidon";
const COMMIT = "c78a6c9fde4992a98e5e76d3fd556e33bb87935a";
const TAG_OBJECT = "0123456789abcdef0123456789abcdef01234567";

const FAKE_GH = `#!/usr/bin/env bash
# Fake gh: answers the API GETs and issue commands of release-freeze.sh from
# files in $SANDBOX; records issue mutations into mutations.log.
echo "gh $*" >> "$SANDBOX/calls.log"
set -euo pipefail
sub="$1"; shift
case "$sub" in
  api)
    url=""; jq_filter=""
    if [ -f "$SANDBOX/no-tags-auth" ]; then
      echo "gh: Requires authentication (HTTP 401)" >&2
      exit 1
    fi
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --jq) shift; jq_filter="$1" ;;
        -*) ;; # --paginate and friends
        *) if [ -z "$url" ]; then url="$1"; fi ;;
      esac
      shift
    done
    body=""
    case "$url" in
      *"/git/refs/tags" | *"/git/refs/tags?"*)
        body="$(cat "$SANDBOX/refs-tags.json")" ;;
      *"/git/ref/tags/"*)   body="$(cat "$SANDBOX/ref-tag.json")" ;;
      *"/git/tags/"*)       body="$(cat "$SANDBOX/tag-object.json")" ;;
      *"actions/runs?head_sha="*) body="$(cat "$SANDBOX/runs.json")" ;;
      *) body="{}" ;;
    esac
    if [ -n "$jq_filter" ]; then
      # real gh --jq applies raw output (jq -r semantics)
      jq -r "$jq_filter" <<<"$body"
    else
      printf '%s\\n' "$body"
    fi ;;
  issue)
    verb="$1"; shift
    jq_filter=""; title=""; positional=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --jq) shift; jq_filter="$1" ;;
        --title) shift; title="$1" ;;
        --repo|--state|--limit|--json|--label|--comment|--body) shift ;;
        -*) ;;
        *) if [ -z "$positional" ]; then positional="$1"; fi ;;
      esac
      shift
    done
    case "$verb" in
      list)
        # gh issue list --json number,title --jq '<filter>' (--jq: raw out)
        if [ -n "$jq_filter" ]; then
          jq -r "$jq_filter" "$SANDBOX/issues.json"
        else
          cat "$SANDBOX/issues.json"
        fi ;;
      create)
        printf 'create title=%s\n' "$title" >> "$SANDBOX/mutations.log"
        n=$(( 10#$(jq 'length' "$SANDBOX/issues.json") + 100 ))
        jq --arg t "$title" --argjson n "$n" '. + [{number: $n, title: $t}]' "$SANDBOX/issues.json" > "$SANDBOX/issues.json.tmp"
        mv "$SANDBOX/issues.json.tmp" "$SANDBOX/issues.json" ;;
      close)
        num="$positional"
        printf 'close number=%s\n' "$num" >> "$SANDBOX/mutations.log"
        jq --argjson n "$num" '[.[] | select(.number != $n)]' "$SANDBOX/issues.json" > "$SANDBOX/issues.json.tmp"
        mv "$SANDBOX/issues.json.tmp" "$SANDBOX/issues.json" ;;
    esac ;;
esac
`;

function writeJson(dir, name, value) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
}

function makeSandbox(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-freeze-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "gh"), FAKE_GH, { mode: 0o755 });
  // State: newest tag myr-v1.6.5 (annotated), myr-v1.6.10 sorts above 1.6.5
  // only when the version sort works (lexical ref order would say 1.6.5 > 1.6.10? no:
  // "myr-v1.6.10" < "myr-v1.6.5" lexically — the semver sort is what the test pins).
  const tags = opts.tags ?? [
    { ref: "refs/tags/myr-v1.5.0" },
    { ref: "refs/tags/myr-v1.6.4" },
    { ref: "refs/tags/myr-v1.6.10" },
    { ref: "refs/tags/myr-v1.6.5" },
    { ref: "refs/tags/nightly-2026-10-01" }, // not a release tag: ignored
  ];
  writeJson(dir, "refs-tags.json", tags);
  writeJson(dir, "ref-tag.json", {
    object: { type: "tag", sha: TAG_OBJECT },
  });
  writeJson(dir, "tag-object.json", { object: { sha: COMMIT } });
  // One CI run for the tag commit; conclusion/status from opts. Default:
  // the tag workflow (myrmidon-ci-tag.yml) on the tag head_branch — the
  // selection the gate must see (regression of the 1.6.5-rc.6 freeze:
  // filtering on myrmidon-ci.yml only leaves the verdict "missing" forever).
  const run = {
    path: opts.runPath ?? ".github/workflows/myrmidon-ci-tag.yml",
    head_branch: opts.headBranch ?? "myr-v1.6.10",
    status: opts.ciStatus ?? "completed",
    conclusion: opts.ciConclusion ?? "success",
  };
  writeJson(dir, "runs.json", { workflow_runs: opts.noRuns ? [] : [run] });
  writeJson(dir, "issues.json", opts.issues ?? []);
  return { dir, bin };
}

function runScript(sandbox, mode, extraEnv = {}) {
  return spawnSync("bash", [SCRIPT, mode], {
    env: {
      ...process.env,
      SANDBOX: sandbox.dir,
      PATH: `${sandbox.bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY: REPO,
      GITHUB_TOKEN: "test-token",
      GH_TOKEN: "",
      GH_FREEZE_TOKEN: "",
      ...extraEnv,
    },
    encoding: "utf8",
  });
}

describe("release-freeze.sh (fake gh)", () => {
  it("no release tags -> no freeze, both modes exit 0", () => {
    const sb = makeSandbox({ tags: [{ ref: "refs/tags/nightly-1" }] });
    const setR = runScript(sb, "--set-state");
    assert.equal(setR.status, 0, setR.stderr);
    assert.match(setR.stdout, /freeze=inactive/);
    const check = runScript(sb, "--check");
    assert.equal(check.status, 0, check.stderr);
  });

  it("fails closed when the token cannot list tags (gate red, set-state error)", () => {
    const sb = makeSandbox({ tags: [{ ref: "refs/tags/nightly-1" }] });
    fs.writeFileSync(path.join(sb.dir, "no-tags-auth"), "1");
    const check = runScript(sb, "--check");
    assert.equal(check.status, 1, check.stderr);
    assert.match(check.stderr, /cannot query the repo state/);
    const setR = runScript(sb, "--set-state");
    assert.equal(setR.status, 1, setR.stderr);
  });

  it("final tag wins over its rc even when the rc CI is green (freeze engages on the final cut)", () => {
    const sb = makeSandbox({
      tags: [
        { ref: "refs/tags/myr-v1.6.4" },
        { ref: "refs/tags/myr-v1.6.5-rc.4" },
        { ref: "refs/tags/myr-v1.6.5" }, // final just pushed, its CI is missing
        { ref: "refs/tags/myr-v1.6.10-rc.1" },
      ],
      headBranch: "myr-v1.6.5-rc.4", // rc CI is green...
      ciConclusion: "success",
    });
    // Newest by version is myr-v1.6.10-rc.1 (an rc of a NEWER version beats
    // an older final); the fixture's green CI run answers for the stale rc
    // myr-v1.6.5-rc.4, so the newest tag's CI is missing -> freeze active.
    const r = runScript(sb, "--check");
    assert.equal(r.status, 1, `expected red gate: ${r.stderr}`);
    assert.match(r.stderr, /RELEASE FREEZE ACTIVE/);
    assert.match(r.stderr, /newest release tag: myr-v1\.6\.10-rc\.1/);
  });

  it("final of the same version outranks its rc (myr-v1.6.5 > myr-v1.6.5-rc.4)", () => {
    const sb = makeSandbox({
      tags: [
        { ref: "refs/tags/myr-v1.6.5-rc.4" }, // rc CI green below
        { ref: "refs/tags/myr-v1.6.5" },      // final pushed, CI not reported yet
      ],
      headBranch: "myr-v1.6.5-rc.4",
      ciConclusion: "success",
    });
    const r = runScript(sb, "--check");
    assert.equal(r.status, 1, `expected red gate: ${r.stderr}`);
    assert.match(r.stderr, /RELEASE FREEZE ACTIVE/);
    assert.match(r.stderr, /newest release tag: myr-v1\.6\.5$/m);
  });

  it("picks the NEWEST tag by semver, not lexical ref order (1.6.10 > 1.6.5)", () => {
    const sb = makeSandbox({ ciConclusion: "success" });
    // The fake's runs.json answers for head_branch myr-v1.6.10 — but the
    // verdict must be about the newest tag. --set-state must NOT open an
    // issue for 1.6.5 when 1.6.10 is the newest.
    const r = runScript(sb, "--set-state");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /freeze=inactive/);
    assert.match(r.stderr, /newest release tag: myr-v1\.6\.10/);
  });

  it("--check is RED while the newest tag CI is in progress (freeze active)", () => {
    const sb = makeSandbox({ ciStatus: "in_progress", ciConclusion: null });
    const r = runScript(sb, "--check");
    assert.equal(r.status, 1, `expected red gate: ${r.stderr}`);
    assert.match(r.stderr, /RELEASE FREEZE ACTIVE/);
  });

  it("--check accepts a green TAG-workflow run (myrmidon-ci-tag.yml on the tag)", () => {
    // Regression test: the tag workflow runs the full pipeline on the tag
    // itself; a gate that filters on myrmidon-ci.yml only never sees it and
    // the verdict stays "missing" forever (freeze stuck ACTIVE).
    const sb = makeSandbox({
      runPath: ".github/workflows/myrmidon-ci-tag.yml",
      headBranch: "myr-v1.6.10",
      ciConclusion: "success",
    });
    const r = runScript(sb, "--check");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /merges open/);
  });

  it("--check accepts a green MAIN-workflow run of the tag commit (fallback for tags without a tag-CI run)", () => {
    const sb = makeSandbox({
      runPath: ".github/workflows/myrmidon-ci.yml",
      headBranch: "main",
      ciConclusion: "success",
    });
    const r = runScript(sb, "--check");
    assert.equal(r.status, 0, r.stderr);
  });

  it("--check stays RED when the tag workflow runs on a DIFFERENT branch name (path/head_branch must pair)", () => {
    // A myrmidon-ci-tag.yml run whose head_branch is not the newest tag must
    // not clear the freeze: the pairing guard keeps verdict "missing".
    const sb = makeSandbox({
      runPath: ".github/workflows/myrmidon-ci-tag.yml",
      headBranch: "myr-v1.6.9", // not the newest tag (1.6.10)
      ciConclusion: "success",
    });
    const r = runScript(sb, "--check");
    assert.equal(r.status, 1, `expected red gate: ${r.stderr}`);
    assert.match(r.stderr, /RELEASE FREEZE ACTIVE/);
  });

  it("--check is GREEN once the tag CI succeeded (freeze cleared)", () => {
    const sb = makeSandbox({ ciConclusion: "success" });
    const r = runScript(sb, "--check");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /merges open/);
  });

  it("--check accepts a green MAIN-branch run of the tag commit (legacy fallback; pairing keeps it valid)", () => {
    const sb = makeSandbox({
      runPath: ".github/workflows/myrmidon-ci.yml",
      headBranch: "main",
      ciConclusion: "success",
    });
    const r = runScript(sb, "--check");
    assert.equal(r.status, 0, r.stderr);
  });

  it("--set-state opens exactly one freeze issue while the tag CI is pending; re-run is idempotent", () => {
    const sb = makeSandbox({ noRuns: true }); // CI run not visible yet -> missing -> freeze
    const first = runScript(sb, "--set-state");
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /freeze=active/);
    const issues = JSON.parse(fs.readFileSync(path.join(sb.dir, "issues.json"), "utf8"));
    assert.equal(issues.length, 1);
    assert.equal(issues[0].title, "release-freeze: myr-v1.6.10");
    const second = runScript(sb, "--set-state");
    assert.equal(second.status, 0, second.stderr);
    const issues2 = JSON.parse(fs.readFileSync(path.join(sb.dir, "issues.json"), "utf8"));
    assert.equal(issues2.length, 1, "second run must not open a duplicate issue");
  });

  it("--set-state closes the freeze issue when the tag CI is green", () => {
    const sb = makeSandbox({
      ciConclusion: "success",
      issues: [{ number: 7, title: "release-freeze: myr-v1.6.10" }],
    });
    const r = runScript(sb, "--set-state");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /freeze=inactive/);
    const issues = JSON.parse(fs.readFileSync(path.join(sb.dir, "issues.json"), "utf8"));
    assert.equal(issues.length, 0);
    const mutations = fs.readFileSync(path.join(sb.dir, "mutations.log"), "utf8");
    assert.match(mutations, /close number=7/);
  });

  it("--check stays RED while the freeze issue is open and the tag CI is not green", () => {
    const sb = makeSandbox({
      ciStatus: "in_progress",
      ciConclusion: null,
      issues: [{ number: 7, title: "release-freeze: myr-v1.6.10" }],
    });
    const r = runScript(sb, "--check");
    assert.equal(r.status, 1, `expected red gate: ${r.stderr}`);
  });

  it("--check is GREEN with an open freeze issue once the tag CI is green (clear lag)", () => {
    // --set-state may not have run yet after the green tag CI; the PR gate
    // must not stay red in that window.
    const sb = makeSandbox({
      ciConclusion: "success",
      issues: [{ number: 7, title: "release-freeze: myr-v1.6.10" }],
    });
    const r = runScript(sb, "--check");
    assert.equal(r.status, 0, r.stderr);
  });

  it("a FAILED tag CI is not a merge freeze (the publish gate refuses that release separately)", () => {
    const sb = makeSandbox({ ciConclusion: "failure" });
    const r = runScript(sb, "--check");
    assert.equal(r.status, 0, r.stderr);
  });
});
