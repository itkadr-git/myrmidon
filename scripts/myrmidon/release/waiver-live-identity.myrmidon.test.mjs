import test from "node:test";
import assert from "node:assert/strict";
import { validateEvidence } from "./release-flaky-waiver.mjs";

const ids = [101, 202, 303];
const permutations = ([a, b, c]) => [
  [a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a],
];

function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function fixtures(evidenceIds = ids, liveIds = ids) {
  const evidence = {
    tag: "myr-v1.7.0", headSha: "abc123", runId: 42, previousAttempt: 1, attempt: 2,
    jobs: evidenceIds.map((id) => ({ id, status: "completed", conclusion: "success", runAttempt: 2 })),
  };
  const run = {
    head_sha: "abc123", run_attempt: 2, status: "completed", conclusion: "success",
    jobs: liveIds.map((id) => ({ id, status: "completed", conclusion: "success", run_attempt: 2 })),
  };
  return { evidence, run };
}

function validate(evidence, run) {
  return validateEvidence(evidence, run, "abc123", "myr-v1.7.0");
}

test("accepts every independent evidence and live job ordering without mutation", () => {
  for (const evidenceIds of permutations(ids)) {
    for (const liveIds of permutations(ids)) {
      const { evidence, run } = fixtures(evidenceIds, liveIds);
      const before = structuredClone({ evidence, run });
      deepFreeze(evidence);
      deepFreeze(run);
      assert.doesNotThrow(() => validate(evidence, run));
      assert.deepEqual({ evidence, run }, before);
    }
  }
});

test("rejects each isolated live identity mismatch without affecting valid calls", () => {
  const changes = [
    ["absent from evidence", (job) => { job.id = 404; }],
    ["null", (job) => { job.id = null; }],
    ["undefined", (job) => { job.id = undefined; }],
    ["string instead of number", (job) => { job.id = String(job.id); }],
  ];
  for (const [label, change] of changes) {
    for (let index = 0; index < ids.length; index += 1) {
      const { evidence, run } = fixtures();
      change(run.jobs[index]);
      const before = structuredClone({ evidence, run });
      deepFreeze(evidence);
      deepFreeze(run);
      const control = fixtures();
      deepFreeze(control);
      assert.doesNotThrow(() => validate(control.evidence, control.run));
      assert.throws(() => validate(evidence, run), /live jobs/, `${label} at ${index}`);
      assert.deepEqual({ evidence, run }, before);
      assert.doesNotThrow(() => validate(control.evidence, control.run));
    }
  }
});
