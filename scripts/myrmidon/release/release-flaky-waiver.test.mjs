import test from "node:test";
import assert from "node:assert/strict";
import { validateEvidence } from "./release-flaky-waiver.mjs";

const proof = {
  tag: "myr-v1.8.0-rc.1", headSha: "abc123", runId: "42",
  previousAttempt: 1, attempt: 2,
  jobs: [{ id: 9, status: "completed", conclusion: "success", runAttempt: 2 }],
};
const success = { head_sha: "abc123", run_attempt: 2, status: "completed", conclusion: "success" };

test("accepts successful jobs on the exact evidenced rerun attempt", () => {
  assert.doesNotThrow(() => validateEvidence(proof, success, "abc123", proof.tag));
});

test("rejects missing or empty job proof", () => {
  assert.throws(() => validateEvidence({ ...proof, jobs: undefined }, success, "abc123", proof.tag), /every job/);
  assert.throws(() => validateEvidence({ ...proof, jobs: [] }, success, "abc123", proof.tag), /every job/);
});

test("rejects any failed or unfinished job despite an overall successful run", () => {
  for (const job of [
    { status: "completed", conclusion: "failure", runAttempt: 2 },
    { status: "in_progress", conclusion: null, runAttempt: 2 },
    { status: "completed", conclusion: "success", runAttempt: 1 },
  ]) {
    assert.throws(() => validateEvidence({ ...proof, jobs: [job] }, success, "abc123", proof.tag), /every job/);
  }
});

test("rejects a tag SHA or exact attempt mismatch", () => {
  assert.throws(() => validateEvidence(proof, success, "different", proof.tag), /tag/);
  assert.throws(() => validateEvidence(proof, { ...success, run_attempt: 3 }, "abc123", proof.tag), /exact evidenced/);
});
