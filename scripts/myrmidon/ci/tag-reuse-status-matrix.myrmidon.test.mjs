import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyRuns } from "./tag-ci-reuse.mjs";

const SHA = "c78a6c9fde4992a98e5e76d3fd556e33bb87935a";
const run = (fields = {}) => ({
  head_sha: SHA,
  event: "push",
  status: "completed",
  conclusion: "success",
  ...fields,
});

describe("tag reuse status matrix", () => {
  for (const status of ["queued", "in_progress", "waiting", "requested", "pending"]) {
    it(`classifies ${status} as pending`, () => {
      assert.equal(classifyRuns([run({ status, conclusion: null })], SHA), "pending");
    });
  }

  for (const conclusion of ["neutral", "skipped", "timed_out", "action_required", null]) {
    it(`classifies completed ${conclusion} as failed`, () => {
      assert.equal(classifyRuns([run({ conclusion })], SHA), "failed");
    });
  }

  for (const event of ["pull_request", "schedule", "release", "", null]) {
    it(`ignores ${event} events even when successful`, () => {
      assert.equal(classifyRuns([run({ event })], SHA), "none");
      assert.equal(classifyRuns([run({ event }), run({ conclusion: "failure" })], SHA), "failed");
    });
  }

  it("ignores successful runs from another SHA", () => {
    assert.equal(classifyRuns([run({ head_sha: "another-sha" })], SHA), "none");
    assert.equal(classifyRuns([run({ head_sha: "another-sha" }), run({ status: "queued" })], SHA), "pending");
  });

  it("uses success over pending over failed in every order", () => {
    const success = run();
    const pending = run({ status: "waiting", conclusion: null });
    const failed = run({ conclusion: "timed_out" });
    for (const runs of [
      [success, pending, failed], [success, failed, pending],
      [pending, success, failed], [pending, failed, success],
      [failed, success, pending], [failed, pending, success],
    ]) assert.equal(classifyRuns(runs, SHA), "success");
    assert.equal(classifyRuns([pending, failed], SHA), "pending");
    assert.equal(classifyRuns([failed, pending], SHA), "pending");
  });

  it("ignores null entries and undefined runs", () => {
    assert.equal(classifyRuns(undefined, SHA), "none");
    assert.equal(classifyRuns([null, undefined], SHA), "none");
    assert.equal(classifyRuns([null, run({ conclusion: "neutral" }), undefined], SHA), "failed");
  });
});
