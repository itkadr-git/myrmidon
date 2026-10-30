import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "hot-files-check.sh");

function runCheck(envOverrides = {}, filesList = [], labelsList = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hot-test-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });

  const fakeGh = path.join(bin, "gh");
  const callsLog = path.join(dir, "calls.log");

  // Format as GitHub API response: [{ filename: "..." }]
  fs.writeFileSync(path.join(dir, "files.json"), JSON.stringify(filesList.map(filename => ({ filename }))));
  // Format as GitHub API response: [{ name: "..." }]
  fs.writeFileSync(path.join(dir, "labels.json"), JSON.stringify(labelsList.map(name => ({ name }))));

  const fakeGhScript = `#!/usr/bin/env bash
echo "gh $*" >> "${callsLog}"
set -euo pipefail
sub="$1"; shift
case "$sub" in
  api)
    jq_filter=""
    url=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --jq) shift; jq_filter="$1" ;;
        -X) shift; method="$1" ;;
        -f) shift; field="$1"; echo "field: $field" >> "${callsLog}" ;;
        -*) ;;
        *) if [ -z "$url" ]; then url="$1"; fi ;;
      esac
      shift
    done
    case "$url" in
      *"pulls/"*"/files")
        jq -r "$jq_filter" "${dir}/files.json" ;;
      *"issues/"*"/labels")
        jq -r "$jq_filter" "${dir}/labels.json" ;;
      *"statuses/"*)
        echo "status call to $url" >> "${callsLog}" ;;
    esac
    ;;
esac
`;
  fs.writeFileSync(fakeGh, fakeGhScript, { mode: 0o755 });

  const env = {
    ...process.env,
    BASH_ENV: "",
    SANDBOX: dir,
    PATH: `${bin}:${process.env.PATH}`,
    EVENT: "pull_request",
    REPO: "itkadr-git/myrmidon",
    PR: "123",
    SHA: "abcdef1234567890",
    ...envOverrides,
  };

  const res = spawnSync("bash", [SCRIPT], { env, encoding: "utf8" });
  const calls = fs.existsSync(callsLog) ? fs.readFileSync(callsLog, "utf8") : "";
  fs.rmSync(dir, { recursive: true, force: true });
  return { ...res, calls };
}

describe("hot-files-check", () => {
  it("passes merge_group without checking files", () => {
    const res = runCheck({ EVENT: "merge_group" });
    assert.equal(res.status, 0);
    assert.match(res.calls, /field: state=success/);
  });

  it("passes when no hot files are touched", () => {
    const res = runCheck({}, ["docs/readme.md", "server/src/utils/math.ts"]);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /Ключевые файлы не затронуты/);
    assert.match(res.calls, /field: state=success/);
    assert.match(res.calls, /no hot files touched/);
  });

  it("sets pending when hot file is touched and review-approved label is missing", () => {
    const res = runCheck({}, ["server/src/services/heartbeat.ts"]);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /PR трогает ключевые файлы ядра/);
    assert.match(res.calls, /field: state=pending/);
    assert.match(res.calls, /waiting for review-approved/);
  });

  it("passes when hot file is touched and review-approved label is present", () => {
    const res = runCheck({}, ["server/src/services/heartbeat.ts"], ["review-approved"]);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /Метка review-approved есть/);
    assert.match(res.calls, /field: state=success/);
    assert.match(res.calls, /review-approved/);
  });
});
