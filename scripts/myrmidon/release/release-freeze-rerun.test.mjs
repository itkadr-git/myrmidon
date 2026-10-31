import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// OPE-10063: release-freeze-rerun.sh against a fake `gh` and a stub gate
// script. The fake answers the two listings from files and records every
// `gh run rerun` into reruns.log; nothing touches GitHub.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "release-freeze-rerun.sh");
const REPO = "itkadr-git/myrmidon";

const FAKE_GH = `#!/usr/bin/env bash
echo "gh $*" >> "$SANDBOX/calls.log"
sub="$1"; shift
case "$sub" in
  api)
    case "$*" in
      *"/pulls?"*) cat "$SANDBOX/pulls.txt" ;;
      *"/workflows/myrmidon-release-freeze.yml/runs?"*) cat "$SANDBOX/failed-runs.txt" ;;
      *) echo "unexpected api call: $*" >&2; exit 1 ;;
    esac ;;
  run)
    verb="$1"; shift
    [ "$verb" = rerun ] || exit 1
    id="$1"
    if grep -qx "$id" "$SANDBOX/rerun-fails.txt" 2>/dev/null; then exit 1; fi
    echo "rerun $*" >> "$SANDBOX/reruns.log" ;;
esac
`;

function makeSandbox({ gateOpen = true, pulls = [], failedRuns = [], rerunFails = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-freeze-rerun-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "gh"), FAKE_GH, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "gate.sh"), `#!/usr/bin/env bash\nexit ${gateOpen ? 0 : 1}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "pulls.txt"), pulls.map(([sha, number]) => `${sha} ${number}`).join("\n"));
  fs.writeFileSync(path.join(dir, "failed-runs.txt"), failedRuns.map(([id, sha]) => `${id} ${sha}`).join("\n"));
  fs.writeFileSync(path.join(dir, "rerun-fails.txt"), rerunFails.join("\n"));
  return { dir, bin };
}

function run(sandbox, extraArgs = []) {
  const result = spawnSync("bash", [SCRIPT, ...extraArgs], {
    env: {
      ...process.env,
      BASH_ENV: "",
      SANDBOX: sandbox.dir,
      PATH: `${sandbox.bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY: REPO,
      GITHUB_TOKEN: "test-token",
      GH_TOKEN: "",
      RELEASE_FREEZE_CHECK: path.join(sandbox.dir, "gate.sh"),
    },
    encoding: "utf8",
  });
  const reruns = fs.existsSync(path.join(sandbox.dir, "reruns.log"))
    ? fs.readFileSync(path.join(sandbox.dir, "reruns.log"), "utf8").trim().split("\n").filter(Boolean)
    : [];
  return { result, reruns };
}

const A = "a".repeat(40);
const B = "b".repeat(40);
const OLD = "c".repeat(40);

describe("release-freeze-rerun.sh (fake gh)", () => {
  it("re-runs the failed gate run of each open PR head once the freeze is lifted", () => {
    const { result, reruns } = run(
      makeSandbox({
        pulls: [[A, 101], [B, 102]],
        failedRuns: [["9001", A], ["9002", B]],
      }),
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(reruns, [`rerun 9001 --failed --repo ${REPO}`, `rerun 9002 --failed --repo ${REPO}`]);
  });

  it("does nothing while the freeze is still active", () => {
    const sandbox = makeSandbox({ gateOpen: false, pulls: [[A, 101]], failedRuns: [["9001", A]] });
    const { result, reruns } = run(sandbox);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(reruns, []);
    assert.equal(fs.existsSync(path.join(sandbox.dir, "calls.log")), false, "no GitHub call while frozen");
  });

  it("skips runs of stale heads and closed PRs, and re-runs only the newest failed run per head", () => {
    const { result, reruns } = run(
      makeSandbox({
        pulls: [[A, 101]],
        failedRuns: [["9003", A], ["9002", OLD], ["9001", A]],
      }),
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(reruns, [`rerun 9003 --failed --repo ${REPO}`]);
  });

  it("carries on when one re-run is refused", () => {
    const { result, reruns } = run(
      makeSandbox({
        pulls: [[A, 101], [B, 102]],
        failedRuns: [["9001", A], ["9002", B]],
        rerunFails: ["9001"],
      }),
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(reruns, [`rerun 9002 --failed --repo ${REPO}`]);
    assert.match(result.stderr, /could not re-run the gate run 9001/);
  });

  it("with nothing failed it re-runs nothing", () => {
    const { result, reruns } = run(makeSandbox({ pulls: [[A, 101]], failedRuns: [] }));
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(reruns, []);
  });

  it("supports --dry-run without issuing any rerun mutations", () => {
    const { result, reruns } = run(
      makeSandbox({
        pulls: [[A, 101]],
        failedRuns: [["9001", A]],
      }),
      ["--dry-run"],
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(reruns, []);
    assert.match(result.stderr, /\[dry-run\] would re-run the gate run 9001/);
  });

  it("provides root and scripts freeze-rerun.sh symlinks", () => {
    const rootSymlink = path.join(HERE, "../../../freeze-rerun.sh");
    assert.equal(fs.existsSync(rootSymlink), true);
    assert.equal(fs.realpathSync(rootSymlink), fs.realpathSync(SCRIPT));
    const scriptsSymlink = path.join(HERE, "freeze-rerun.sh");
    assert.equal(fs.existsSync(scriptsSymlink), true);
    assert.equal(fs.realpathSync(scriptsSymlink), fs.realpathSync(SCRIPT));
  });
});

describe("myrmidon-release-freeze.yml", () => {
  const yml = fs.readFileSync(path.join(HERE, "../../../.github/workflows/myrmidon-release-freeze.yml"), "utf8");

  it("re-runs the failed gate when the tag CI completes, with the permission it needs", () => {
    assert.match(yml, /workflow_run:\s*\n\s+workflows: \["Myrmidon CI \(tag\)"\]\s*\n\s+types: \[completed\]/);
    assert.match(yml, /release-freeze-rerun\.sh/);
    assert.match(yml, /actions: write/);
  });

  it("keeps the gate itself on pull_request events only", () => {
    assert.match(yml, /freeze:\s*\n\s+name: freeze\s*\n\s+if: \$\{\{ github\.repository == 'itkadr-git\/myrmidon' && github\.event_name == 'pull_request' \}\}/);
  });
});
