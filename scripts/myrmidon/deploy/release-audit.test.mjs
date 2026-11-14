import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, "lib.sh");

function runAudit(stateDir, calls) {
  const script = [
    "set -euo pipefail",
    `STATE_DIR=${JSON.stringify(stateDir)}`,
    `source ${JSON.stringify(LIB)}`,
    ...calls.map((call) => `record_release_event ${call.map((value) => JSON.stringify(value)).join(" ")}`),
  ].join("\n");
  return spawnSync("bash", ["-c", script], { encoding: "utf8" });
}

function readEvents(stateDir) {
  const file = path.join(stateDir, "release-events.jsonl");
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("release audit journal", () => {
  it("records intent and successful result for a deployment", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-release-audit-"));
    const result = runAudit(stateDir, [
      ["deploy.intent", "job-success", "sha256:abc", "planned", "executor accepted"],
      ["deploy.result", "job-success", "sha256:abc", "succeeded", "deploy finished"],
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readEvents(stateDir).map(({ event, status }) => ({ event, status })), [
      { event: "deploy.intent", status: "planned" },
      { event: "deploy.result", status: "succeeded" },
    ]);
  });

  it("records a failed result and preserves a repeated attempt", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-release-audit-"));
    const result = runAudit(stateDir, [
      ["deploy.intent", "job-failed", "sha256:def", "planned", "executor accepted"],
      ["deploy.result", "job-failed", "sha256:def", "failed", "health check failed"],
      ["deploy.intent", "job-failed", "sha256:def", "planned", "safe continuation retry"],
    ]);
    assert.equal(result.status, 0, result.stderr);
    const events = readEvents(stateDir);
    assert.equal(events.length, 3);
    assert.equal(events[1].status, "failed");
    assert.equal(events[2].detail, "safe continuation retry");
    assert.notEqual(events[0].eventId, events[2].eventId);
  });

  it("fails when the audit file cannot be written", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-release-audit-"));
    const auditFile = path.join(stateDir, "release-events.jsonl");
    fs.mkdirSync(auditFile);
    const result = runAudit(stateDir, [
      ["deploy.intent", "job-fail", "sha256:abc", "planned", "executor accepted"],
    ]);
    assert.notEqual(result.status, 0);
  });
});
