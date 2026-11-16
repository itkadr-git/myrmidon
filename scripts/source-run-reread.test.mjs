import assert from "node:assert/strict";
import test from "node:test";
import { readSourceVerification, sourceVerificationJob } from "./cloud-source-verification.mjs";

const sha = "a".repeat(40);
const run = {
  id: 456, workflow_id: 123, path: ".github/workflows/cloud-readiness.yml", run_attempt: 2,
  repository: { full_name: "paperclipai/paperclip" }, head_repository: { full_name: "paperclipai/paperclip" },
  head_sha: sha, head_branch: "master", event: "push", status: "in_progress", conclusion: null,
};
const paths = [
  "/repos/paperclipai/paperclip/actions/workflows/cloud-readiness.yml",
  `/repos/paperclipai/paperclip/actions/workflows/123/runs?head_sha=${sha}&event=push&branch=master&per_page=100`,
  "/repos/paperclipai/paperclip/actions/runs/456/attempts/2/jobs?per_page=100&page=1",
  "/repos/paperclipai/paperclip/actions/runs/456",
];

for (const [name, currentId, expected] of [
  ["accepts the selected run", 456, { sha, runId: 456, attempt: 2, jobId: 789 }],
  ["rejects a different positive reread run id", 457, undefined],
  ["rejects an invalid reread run id", 0, undefined],
]) {
  test(name, async () => {
    const responses = [
      { id: 123, path: run.path },
      { total_count: 1, workflow_runs: [run] },
      { jobs: [{ id: 789, name: sourceVerificationJob, run_id: 456, run_attempt: 2, head_sha: sha, status: "completed", conclusion: "success" }] },
      { ...run, id: currentId },
    ];
    const calls = [];
    const result = await readSourceVerification(sha, async (path) => {
      calls.push(path);
      assert.equal(path, paths[calls.length - 1]);
      return responses[calls.length - 1];
    });
    assert.deepEqual(calls, paths);
    assert.deepEqual(result, expected);
  });
}
