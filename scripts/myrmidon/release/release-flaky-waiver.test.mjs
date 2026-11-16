import test from "node:test";
import assert from "node:assert/strict";
import { validateEvidence, waiverRecordFromEvidence } from "./release-flaky-waiver.mjs";

const proof = {
  tag: "myr-v1.8.0-rc.1", headSha: "abc123", runId: "42",
  previousAttempt: 1, attempt: 2,
  jobs: [{ id: 9, status: "completed", conclusion: "success", runAttempt: 2 }],
};
const success = { head_sha: "abc123", run_attempt: 2, status: "completed", conclusion: "success" };

test("rejects successful evidence when the live job failed", () => {
  const run = { ...success, jobs: [{ id: 9, status: "completed", conclusion: "failure", run_attempt: 2 }] };
  assert.throws(() => validateEvidence(proof, run, "abc123", proof.tag), /live job/);
});

test("rejects live jobs omitted from evidence", () => {
  const run = { ...success, jobs: [
    { id: 9, status: "completed", conclusion: "success", run_attempt: 2 },
    { id: 10, status: "completed", conclusion: "success", run_attempt: 2 },
  ] };
  assert.throws(() => validateEvidence(proof, run, "abc123", proof.tag), /live job/);
});

test("rejects live jobs from a different attempt", () => {
  const run = { ...success, jobs: [{ id: 9, status: "completed", conclusion: "success", run_attempt: 1 }] };
  assert.throws(() => validateEvidence(proof, run, "abc123", proof.tag), /live job/);
});

test("accepts the complete successful live job set", () => {
  const run = { ...success, jobs: [{ id: 9, status: "completed", conclusion: "success", run_attempt: 2 }] };
  assert.doesNotThrow(() => validateEvidence(proof, run, "abc123", proof.tag));
});

test("preserves offline compatibility when live jobs are omitted", () => {
  assert.doesNotThrow(() => validateEvidence(proof, success, "abc123", proof.tag));
});

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

test("recorded waiver preserves proof required by a later verify", () => {
  const record = waiverRecordFromEvidence(proof, {
    reason: "transient infrastructure failure",
    journal: "OPE-13003",
    actor: "release-bot",
    recordedAt: "2026-11-14T00:00:00.000Z",
  });
  assert.equal(record.headSha, proof.headSha);
  assert.deepEqual(record.jobs, proof.jobs);
  assert.doesNotThrow(() => validateEvidence(record, success, "abc123", proof.tag));
});
