import test from "node:test";
import assert from "node:assert/strict";
import { validateEvidence, waiverRecordFromEvidence } from "./release-flaky-waiver.mjs";

const tag = "myr-v1.7.0-rc.2";
const sha = "0123456789abcdef";

function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function fixture(previousAttempt, attempt) {
  return freeze({
    tag, headSha: sha, runId: 12345, previousAttempt, attempt,
    jobs: [{ id: 37, status: "completed", conclusion: "success", runAttempt: attempt }],
    url: "https://example.invalid/runs/12345",
  });
}

function successfulRun(attempt) {
  return freeze({ head_sha: sha, run_attempt: attempt, status: "completed", conclusion: "success" });
}

test("offline evidence accepts only a strictly increasing attempt transition", async (t) => {
  for (const [previous, current, accepted] of [[1, 2, true], [2, 2, false], [3, 2, false]]) {
    await t.test(`${previous} -> ${current}`, () => {
      const evidence = fixture(previous, current);
      const invoke = () => validateEvidence(evidence, successfulRun(current), sha, tag);
      if (accepted) assert.equal(invoke(), undefined);
      else assert.throws(invoke, /exact evidenced rerun attempt/);
    });
  }
});

test("identity mismatches reject an otherwise valid offline transition", async (t) => {
  const evidence = fixture(1, 2);
  const run = successfulRun(2);
  const cases = [
    ["tag", run, sha, "myr-v1.7.0-rc.3", /evidence must include tag/],
    ["tag head SHA", run, "different", tag, /headSha does not match/],
    ["run head SHA", freeze({ ...run, head_sha: "different" }), sha, tag, /exact evidenced rerun attempt/],
    ["run attempt", freeze({ ...run, run_attempt: 3 }), sha, tag, /exact evidenced rerun attempt/],
  ];
  for (const [name, liveRun, liveSha, liveTag, error] of cases) {
    await t.test(name, () => assert.throws(() => validateEvidence(evidence, liveRun, liveSha, liveTag), error));
  }
});

test("waiver record preserves identity and normalizes string attempts for later verification", () => {
  const evidence = fixture("1", "2");
  const options = freeze({ reason: "transient runner failure", journal: "OPE-13386", actor: "release-bot", recordedAt: "2026-11-16T00:00:00.000Z" });
  const record = waiverRecordFromEvidence(evidence, options);
  assert.deepEqual(record, {
    tag, headSha: sha, runId: "12345", previousAttempt: 1, attempt: 2,
    jobs: evidence.jobs, url: evidence.url, verdict: "not-related-to-changes", ...options,
  });
  assert.equal(validateEvidence(freeze(record), successfulRun(2), sha, tag), undefined);
});
