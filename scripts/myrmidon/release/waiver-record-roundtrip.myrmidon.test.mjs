import test from "node:test";
import assert from "node:assert/strict";
import { validateEvidence, waiverRecordFromEvidence } from "./release-flaky-waiver.mjs";

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const cases = [
  { tag: "myr-v1.7.0-rc.1", headSha: "abc123", runId: 42, previousAttempt: "1", attempt: "2", url: "https://example.invalid/runs/42", ids: [9, 10], reason: "transient runner failure", journal: "OPE-123", actor: "release-bot", recordedAt: "2026-11-14T00:00:00.000Z" },
  { tag: "myr-v1.7.0-rc.2", headSha: "def456", runId: 987, previousAttempt: "3", attempt: "4", url: "https://example.invalid/runs/987", ids: [21, 22, 23], reason: "network interruption", journal: "OPE-456", actor: "operator", recordedAt: "2026-11-15T12:30:00.000Z" },
];

test("records exact waiver fields and validates JSON round trips without changing inputs", () => {
  for (const fixture of cases) {
    const jobs = fixture.ids.map((id) => ({ id, status: "completed", conclusion: "success", runAttempt: Number(fixture.attempt) }));
    const evidence = deepFreeze({ tag: fixture.tag, headSha: fixture.headSha, runId: fixture.runId, previousAttempt: fixture.previousAttempt, attempt: fixture.attempt, jobs, url: fixture.url });
    const options = deepFreeze({ reason: fixture.reason, journal: fixture.journal, actor: fixture.actor, recordedAt: fixture.recordedAt });
    const evidenceBefore = structuredClone(evidence);
    const optionsBefore = structuredClone(options);
    const run = deepFreeze({ head_sha: fixture.headSha, run_attempt: Number(fixture.attempt), status: "completed", conclusion: "success", jobs: fixture.ids.map((id) => ({ id, status: "completed", conclusion: "success", run_attempt: Number(fixture.attempt) })) });
    const record = waiverRecordFromEvidence(evidence, options);
    assert.deepEqual(record, {
      tag: fixture.tag, headSha: fixture.headSha, runId: String(fixture.runId),
      previousAttempt: Number(fixture.previousAttempt), attempt: Number(fixture.attempt),
      jobs, url: fixture.url, verdict: "not-related-to-changes",
      reason: fixture.reason, journal: fixture.journal, actor: fixture.actor, recordedAt: fixture.recordedAt,
    });
    const roundTrip = JSON.parse(JSON.stringify(record));
    assert.deepEqual(roundTrip, record);
    assert.doesNotThrow(() => validateEvidence(roundTrip, run, fixture.headSha, fixture.tag));
    assert.throws(() => validateEvidence(roundTrip, run, "wrong-sha", fixture.tag), /tag/);
    assert.throws(() => validateEvidence(roundTrip, { ...run, jobs: [...run.jobs, { id: 999, status: "completed", conclusion: "success", run_attempt: Number(fixture.attempt) }] }, fixture.headSha, fixture.tag), /live job/);
    assert.deepEqual(evidence, evidenceBefore);
    assert.deepEqual(options, optionsBefore);
  }
});
