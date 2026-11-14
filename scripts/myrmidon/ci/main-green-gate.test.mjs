import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// MERGE-ON-RED-MAIN (OPE-10789):
// Integration tests for main-green-gate.sh and main-green-rerun.sh.
// Runs against a fake `gh` (and fake `git`) in an isolated sandbox.
// Tests the gate decision and that PR merge / autoupdate is blocked on red main
// and permitted on green main.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE_SCRIPT = path.join(HERE, "main-green-gate.sh");
const RERUN_SCRIPT = path.join(HERE, "main-green-rerun.sh");
const REPO = "itkadr-git/myrmidon";
const GREEN_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const RED_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const NEW_SHA = "cccccccccccccccccccccccccccccccccccccccc";

const FAKE_GH = `#!/usr/bin/env bash
echo "gh $*" >> "$SANDBOX/calls.log"
set -euo pipefail
sub="$1"; shift

case "$sub" in
  api)
    if [ -f "$SANDBOX/api-down" ]; then
      echo "gh: API connection refused (HTTP 500)" >&2
      exit 1
    fi
    url=""
    jq_filter=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --jq) shift; jq_filter="$1" ;;
        -*) ;;
        *) if [ -z "$url" ]; then url="$1"; fi ;;
      esac
      shift
    done

    body="{}"
    case "$url" in
      *"repos/"* | "repos/"*)
        if [[ "$url" =~ /commits/ ]]; then
          commit="\${url##*/commits/}"
          commit="\${commit%%/*}"
          commit="\${commit%%\\?*}"
          if [ "$commit" = "main" ]; then
            body="$(cat "$SANDBOX/commit-main.json")"
          elif [ -f "$SANDBOX/check-runs-$commit.json" ]; then
            body="$(cat "$SANDBOX/check-runs-$commit.json")"
          else
            body='{"sha": "'"$commit"'"}'
          fi
        elif [[ "$url" =~ /actions/ ]]; then
          body="$(cat "$SANDBOX/runs.json")"
        elif [[ "$url" =~ /pulls ]]; then
          body="$(cat "$SANDBOX/pulls.json")"
        else
          body='{"full_name": "'"\${GITHUB_REPOSITORY:-itkadr-git/myrmidon}"'"}'
        fi
        ;;
      *)
        body="{}"
        ;;
    esac

    if [ -n "$jq_filter" ]; then
      jq -r "$jq_filter" <<<"$body"
    else
      printf '%s\\n' "$body"
    fi
    ;;

  issue)
    verb="$1"; shift
    jq_filter=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --jq) shift; jq_filter="$1" ;;
        -*) ;;
        *) ;;
      esac
      shift
    done
    case "$verb" in
      list)
        if [ -n "$jq_filter" ]; then
          jq -r "$jq_filter" "$SANDBOX/issues.json"
        else
          cat "$SANDBOX/issues.json"
        fi
        ;;
    esac
    ;;

  run)
    verb="$1"; shift
    case "$verb" in
      rerun)
        run_id="$1"; shift || true
        printf 'rerun run_id=%s\\n' "$run_id" >> "$SANDBOX/reruns.log"
        exit 0
        ;;
    esac
    ;;

  pr)
    verb="$1"; shift
    case "$verb" in
      merge)
        # Check if gate check passed
        pr_number="$1"; shift || true
        printf 'merge pr=%s\\n' "$pr_number" >> "$SANDBOX/merges.log"
        exit 0
        ;;
    esac
    ;;
esac
`;

function writeJson(dir, name, value) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
}

function makeSandbox(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "main-green-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "gh"), FAKE_GH, { mode: 0o755 });

  writeJson(dir, "issues.json", opts.issues ?? []);
  writeJson(dir, "commit-main.json", { sha: opts.headSha ?? GREEN_SHA });
  writeJson(dir, "runs.json", opts.runs ?? {
    workflow_runs: [
      {
        id: 1001,
        name: "Myrmidon CI",
        path: ".github/workflows/myrmidon-ci.yml",
        head_branch: "main",
        head_sha: GREEN_SHA,
        status: "completed",
        conclusion: "success",
        created_at: "2026-11-03T12:00:00Z",
      },
    ],
  });
  writeJson(dir, "pulls.json", opts.pulls ?? []);

  if (opts.apiDown) {
    fs.writeFileSync(path.join(dir, "api-down"), "1");
  }

  return dir;
}

function runGate(sandbox, args = []) {
  return spawnSync(GATE_SCRIPT, args, {
    env: {
      PATH: `${path.join(sandbox, "bin")}:${process.env.PATH}`,
      SANDBOX: sandbox,
      GITHUB_REPOSITORY: REPO,
      GITHUB_TOKEN: "mock-token",
      BASE_BRANCH: "main",
    },
    encoding: "utf8",
  });
}

function runRerun(sandbox, args = []) {
  return spawnSync(RERUN_SCRIPT, args, {
    env: {
      PATH: `${path.join(sandbox, "bin")}:${process.env.PATH}`,
      SANDBOX: sandbox,
      GITHUB_REPOSITORY: REPO,
      GITHUB_TOKEN: "mock-token",
      MAIN_GREEN_CHECK: GATE_SCRIPT,
    },
    encoding: "utf8",
  });
}

describe("main-green-gate.sh (OPE-10789)", () => {
  it("fails closed (exit 1, red) when GitHub API / auth is broken", () => {
    const sandbox = makeSandbox({ apiDown: true });
    const res = runGate(sandbox, ["--check"]);
    assert.equal(res.status, 1, "must fail closed");
    assert.match(res.stderr, /cannot query repository state/i);
  });

  it("is RED (exit 1) when an open issue with label main-red exists", () => {
    const sandbox = makeSandbox({
      issues: [{ number: 999, title: "main broken at 12:34" }],
      runs: {
        workflow_runs: [
          {
            id: 1001,
            head_branch: "main",
            head_sha: GREEN_SHA,
            status: "completed",
            conclusion: "success",
            created_at: "2026-11-03T12:00:00Z",
          },
        ],
      },
    });
    const res = runGate(sandbox, ["--check"]);
    assert.equal(res.status, 1, "gate must be red when main-red issue is open");
    assert.match(res.stderr, /open main-red issue/i);
  });

  it("is RED (exit 1) when the latest Myrmidon CI run on main failed (OPE-10788 scenario)", () => {
    const sandbox = makeSandbox({
      headSha: RED_SHA,
      runs: {
        workflow_runs: [
          {
            id: 2002,
            name: "Myrmidon CI",
            path: ".github/workflows/myrmidon-ci.yml",
            head_branch: "main",
            head_sha: RED_SHA,
            status: "completed",
            conclusion: "failure",
            created_at: "2026-11-03T12:34:00Z",
          },
        ],
      },
    });
    const res = runGate(sandbox, ["--check"]);
    assert.equal(res.status, 1, "gate must be red when latest run failed");
    assert.match(res.stderr, /MAIN BRANCH CI IS RED.*failure/i);
  });

  it("is RED (exit 1) when the latest Myrmidon CI run on main timed out or was cancelled", () => {
    const sandbox = makeSandbox({
      runs: {
        workflow_runs: [
          {
            id: 2003,
            head_branch: "main",
            head_sha: RED_SHA,
            status: "completed",
            conclusion: "timed_out",
            created_at: "2026-11-03T12:35:00Z",
          },
        ],
      },
    });
    const res = runGate(sandbox, ["--check"]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /MAIN BRANCH CI IS RED.*timed_out/i);
  });

  it("OPE-12889: is GREEN (exit 0) while a new main CI run is in_progress and the latest completed run succeeded", () => {
    const sandbox = makeSandbox({
      headSha: NEW_SHA, // reviewer case: HEAD moved past the completed run
      runs: {
        workflow_runs: [
          // Newest run: still running on the fresh commit (main CI takes ~40 min).
          {
            id: 2004,
            head_branch: "main",
            head_sha: NEW_SHA,
            status: "in_progress",
            conclusion: null,
            created_at: "2026-11-03T12:40:00Z",
          },
          // Previous completed run on the merged commit was green.
          {
            id: 1001,
            head_branch: "main",
            head_sha: GREEN_SHA,
            status: "completed",
            conclusion: "success",
            created_at: "2026-11-03T12:00:00Z",
          },
        ],
      },
    });
    const res = runGate(sandbox, ["--check"]);
    assert.equal(res.status, 0, "an in-progress run must not turn the gate red");
    assert.match(res.stderr, /main branch CI is GREEN/i);
    assert.match(res.stderr, /run #2004 is in_progress/);
  });

  it("OPE-12889: is GREEN (exit 0) while the newest main CI run is queued and the latest completed run succeeded", () => {
    const sandbox = makeSandbox({
      headSha: NEW_SHA, // reviewer case: HEAD moved past the completed run
      runs: {
        workflow_runs: [
          {
            id: 2005,
            head_branch: "main",
            head_sha: NEW_SHA,
            status: "queued",
            conclusion: null,
            created_at: "2026-11-03T12:41:00Z",
          },
          {
            id: 1001,
            head_branch: "main",
            head_sha: GREEN_SHA,
            status: "completed",
            conclusion: "success",
            created_at: "2026-11-03T12:00:00Z",
          },
        ],
      },
    });
    const res = runGate(sandbox, ["--status"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "green");
  });

  it("OPE-12889: is RED (exit 1) when the latest completed run failed even though a newer run is in_progress", () => {
    const sandbox = makeSandbox({
      runs: {
        workflow_runs: [
          {
            id: 2006,
            head_branch: "main",
            head_sha: NEW_SHA,
            status: "in_progress",
            conclusion: null,
            created_at: "2026-11-03T13:10:00Z",
          },
          {
            id: 2002,
            head_branch: "main",
            head_sha: RED_SHA,
            status: "completed",
            conclusion: "failure",
            created_at: "2026-11-03T12:34:00Z",
          },
        ],
      },
    });
    const res = runGate(sandbox, ["--check"]);
    assert.equal(res.status, 1, "gate must be red when the last completed run failed");
    assert.match(res.stderr, /MAIN BRANCH CI IS RED.*run #2002 concluded with failure/i);
  });

  it("OPE-12889: is RED (exit 1) with a reason when no completed run exists (only in_progress)", () => {
    const sandbox = makeSandbox({
      headSha: NEW_SHA,
      runs: {
        workflow_runs: [
          {
            id: 2007,
            head_branch: "main",
            head_sha: NEW_SHA,
            status: "in_progress",
            conclusion: null,
            created_at: "2026-11-03T12:40:00Z",
          },
        ],
      },
    });
    const res = runGate(sandbox, ["--check"]);
    assert.equal(res.status, 1, "no completed run at all must fail closed");
    assert.match(res.stderr, /CANNOT CONFIRM GREEN STATUS/i);
    assert.match(res.stderr, /run #2007 is in_progress/i);
  });

  it("is RED (exit 1) when main HEAD moved to a new commit whose CI has completed with failure", () => {
    const sandbox = makeSandbox({
      headSha: NEW_SHA, // main moved to NEW_SHA
      runs: {
        workflow_runs: [
          // The run on NEW_SHA completed with failure.
          {
            id: 2008,
            head_branch: "main",
            head_sha: NEW_SHA,
            status: "completed",
            conclusion: "failure",
            created_at: "2026-11-03T12:50:00Z",
          },
          // The previous commit was green but is no longer the latest completed run.
          {
            id: 1001,
            head_branch: "main",
            head_sha: GREEN_SHA,
            status: "completed",
            conclusion: "success",
            created_at: "2026-11-03T12:00:00Z",
          },
        ],
      },
    });

    const res = runGate(sandbox, ["--check"]);
    assert.equal(res.status, 1, "gate must be red when the run on HEAD completed with failure");
    assert.match(res.stderr, /MAIN BRANCH CI IS RED.*run #2008 concluded with failure/i);
  });

  it("is GREEN (exit 0) when the latest Myrmidon CI on main succeeded and no main-red issue exists", () => {
    const sandbox = makeSandbox({
      headSha: GREEN_SHA,
      runs: {
        workflow_runs: [
          {
            id: 3001,
            name: "Myrmidon CI",
            path: ".github/workflows/myrmidon-ci.yml",
            head_branch: "main",
            head_sha: GREEN_SHA,
            status: "completed",
            conclusion: "success",
            created_at: "2026-11-03T13:00:00Z",
          },
        ],
      },
    });
    const res = runGate(sandbox, ["--check"]);
    assert.equal(res.status, 0, "gate must be green");
    assert.match(res.stderr, /main branch CI is GREEN/i);
  });

  it("supports --status output mode", () => {
    const redSandbox = makeSandbox({
      runs: {
        workflow_runs: [
          {
            id: 2002,
            head_branch: "main",
            head_sha: RED_SHA,
            status: "completed",
            conclusion: "failure",
            created_at: "2026-11-03T12:34:00Z",
          },
        ],
      },
    });
    const redRes = runGate(redSandbox, ["--status"]);
    assert.equal(redRes.status, 0);
    assert.match(redRes.stdout, /^red:latest completed run #2002 concluded with failure/);

    const greenSandbox = makeSandbox({
      headSha: GREEN_SHA,
      runs: {
        workflow_runs: [
          {
            id: 3001,
            head_branch: "main",
            head_sha: GREEN_SHA,
            status: "completed",
            conclusion: "success",
            created_at: "2026-11-03T13:00:00Z",
          },
        ],
      },
    });
    const greenRes = runGate(greenSandbox, ["--status"]);
    assert.equal(greenRes.status, 0);
    assert.equal(greenRes.stdout.trim(), "green");
  });

  it("OPE-11694: is GREEN when main CI run is green even if a tag CI run on the same SHA is red", () => {
    const SAME_SHA = "3a085ac83aaeaa216fb2895157450035270767b6";
    const sandbox = makeSandbox({
      headSha: SAME_SHA,
      runs: {
        workflow_runs: [
          // Tag CI run on the same SHA was created later and failed (e.g. rc.34 failure)
          {
            id: 41952676310,
            name: "Myrmidon CI (tag)",
            path: ".github/workflows/myrmidon-ci-tag.yml",
            head_branch: "myr-v1.6.6-rc.34",
            head_sha: SAME_SHA,
            event: "push",
            status: "completed",
            conclusion: "failure",
            created_at: "2026-11-05T02:26:00Z",
          },
          // Main branch CI run on SAME_SHA was completed successfully
          {
            id: 41949314014,
            name: "Myrmidon CI",
            path: ".github/workflows/myrmidon-ci.yml",
            head_branch: "main",
            head_sha: SAME_SHA,
            event: "push",
            status: "completed",
            conclusion: "success",
            created_at: "2026-11-05T01:33:00Z",
          },
        ],
      },
    });

    // Check-runs on this SHA contains the failed CI result check from the tag run
    writeJson(sandbox, `check-runs-${SAME_SHA}.json`, {
      check_runs: [
        {
          name: "CI result",
          status: "completed",
          conclusion: "failure",
          started_at: "2026-11-05T02:26:22Z",
        },
        {
          name: "CI result",
          status: "completed",
          conclusion: "success",
          started_at: "2026-11-05T01:54:25Z",
        },
      ],
    });

    const res = runGate(sandbox, ["--check"]);
    assert.equal(res.status, 0, "gate must be green based on main CI run, ignoring tag CI run on same SHA");
    assert.match(res.stderr, /main branch CI is GREEN/i);
  });

  it("OPE-11694: is RED when main CI run on SHA failed, blocking PR merges", () => {
    const SAME_SHA = "3a085ac83aaeaa216fb2895157450035270767b6";
    const sandbox = makeSandbox({
      headSha: SAME_SHA,
      runs: {
        workflow_runs: [
          // Main run failed
          {
            id: 41949314014,
            name: "Myrmidon CI",
            path: ".github/workflows/myrmidon-ci.yml",
            head_branch: "main",
            head_sha: SAME_SHA,
            event: "push",
            status: "completed",
            conclusion: "failure",
            created_at: "2026-11-05T01:33:00Z",
          },
        ],
      },
    });

    const res = runGate(sandbox, ["--check"]);
    assert.equal(res.status, 1, "gate must be red when main CI run failed");
    assert.match(res.stderr, /MAIN BRANCH CI IS RED.*latest completed run #41949314014 concluded with failure/i);
  });
});

describe("Merge gate integration (OPE-10789 Acceptance Criteria)", () => {
  it("blocks PR merge and autoupdate when main is RED; permits merge when main is GREEN", () => {
    // 1. Red main scenario
    const redSandbox = makeSandbox({
      headSha: RED_SHA,
      runs: {
        workflow_runs: [
          {
            id: 2002,
            head_branch: "main",
            head_sha: RED_SHA,
            status: "completed",
            conclusion: "failure",
            created_at: "2026-11-03T12:34:00Z",
          },
        ],
      },
    });

    // Simulating auto-merge gate check on PR #2258:
    const gateOnRed = runGate(redSandbox, ["--check"]);
    assert.equal(gateOnRed.status, 1, "gate check must fail (RED) on red main");

    // Simulating PR merge logic guarded by main-green gate:
    // If gate fails, gh pr merge is NEVER invoked.
    let mergedOnRed = false;
    if (gateOnRed.status === 0) {
      spawnSync(path.join(redSandbox, "bin", "gh"), ["pr", "merge", "2258", "--auto", "--squash"], {
        env: { PATH: `${path.join(redSandbox, "bin")}:${process.env.PATH}`, SANDBOX: redSandbox },
      });
      mergedOnRed = true;
    }
    assert.equal(mergedOnRed, false, "PR #2258 must NOT be merged while main is red");
    assert.equal(fs.existsSync(path.join(redSandbox, "merges.log")), false, "no merge calls allowed on red main");

    // 2. Green main scenario
    const greenSandbox = makeSandbox({
      headSha: GREEN_SHA,
      runs: {
        workflow_runs: [
          {
            id: 3001,
            head_branch: "main",
            head_sha: GREEN_SHA,
            status: "completed",
            conclusion: "success",
            created_at: "2026-11-03T13:00:00Z",
          },
        ],
      },
    });

    const gateOnGreen = runGate(greenSandbox, ["--check"]);
    assert.equal(gateOnGreen.status, 0, "gate check must pass (GREEN) on green main");

    let mergedOnGreen = false;
    if (gateOnGreen.status === 0) {
      spawnSync(path.join(greenSandbox, "bin", "gh"), ["pr", "merge", "2258", "--auto", "--squash"], {
        env: { PATH: `${path.join(greenSandbox, "bin")}:${process.env.PATH}`, SANDBOX: greenSandbox },
      });
      mergedOnGreen = true;
    }
    assert.equal(mergedOnGreen, true, "PR #2258 merge proceeds when main is green");
    const mergeLog = fs.readFileSync(path.join(greenSandbox, "merges.log"), "utf8");
    assert.match(mergeLog, /merge pr=2258/);
  });

  it("reruns failed gate runs of open PRs once main turns green", () => {
    const sandbox = makeSandbox({
      headSha: GREEN_SHA,
      runs: {
        workflow_runs: [
          {
            id: 3001,
            head_branch: "main",
            head_sha: GREEN_SHA,
            status: "completed",
            conclusion: "success",
            created_at: "2026-11-03T13:00:00Z",
          },
          // Failed gate run for PR 2258
          {
            id: 9001,
            head_sha: "pr2258sha123456789012345678901234567890",
            status: "completed",
            conclusion: "failure",
            created_at: "2026-11-03T12:35:00Z",
          },
        ],
      },
      pulls: [
        {
          number: 2258,
          head: { sha: "pr2258sha123456789012345678901234567890" },
        },
      ],
    });

    const rerunRes = runRerun(sandbox);
    assert.equal(rerunRes.status, 0);
    assert.match(rerunRes.stderr, /re-ran 1 gate run/);

    const rerunLog = fs.readFileSync(path.join(sandbox, "reruns.log"), "utf8");
    assert.match(rerunLog, /rerun run_id=9001/);
  });
});
