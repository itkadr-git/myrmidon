import assert from "node:assert/strict";
import test from "node:test";
import { readSourceVerification, sourceVerificationJob } from "./cloud-source-verification.mjs";

const sha = "a".repeat(40);
const repo = "paperclipai/paperclip";
const workflow = { id: 123, path: ".github/workflows/cloud-readiness.yml" };
const run = {
  id: 456, workflow_id: 123, path: workflow.path, run_attempt: 2,
  repository: { full_name: repo }, head_repository: { full_name: repo },
  head_sha: sha, head_branch: "master", event: "push", status: "in_progress", conclusion: null,
};
const job = { id: 789, name: sourceVerificationJob, run_id: 456, run_attempt: 2, head_sha: sha, status: "completed", conclusion: "success" };

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function fixture({ runs = [run], jobs = [job], current = run, workflowRecord = workflow } = {}) {
  deepFreeze({ runs, jobs, current, workflowRecord });
  const calls = [];
  const api = async (path) => {
    calls.push(path);
    if (path === `/repos/${repo}/actions/workflows/cloud-readiness.yml`) return workflowRecord;
    if (path === `/repos/${repo}/actions/workflows/123/runs?head_sha=${sha}&event=push&branch=master&per_page=100`) return deepFreeze({ total_count: runs.length, workflow_runs: runs });
    if (/\/attempts\/\d+\/jobs\?per_page=100&page=1$/.test(path)) return deepFreeze({ jobs });
    if (/\/actions\/runs\/\d+$/.test(path)) return current;
    throw new Error(`Unexpected API path: ${path}`);
  };
  return { api, calls };
}

test("invalid run identifiers cannot produce proof", async () => {
  for (const id of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const f = fixture({ runs: [{ ...run, id }] });
    assert.equal(await readSourceVerification(sha, f.api), undefined, `id=${id}`);
    assert.equal(f.calls.length, 2);
  }
});

test("invalid workflow identifiers fail before listing runs", async () => {
  for (const id of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const f = fixture({ workflowRecord: { ...workflow, id } });
    await assert.rejects(readSourceVerification(sha, f.api), /workflow identity/);
    assert.equal(f.calls.length, 1);
  }
});

test("newest pending trusted run wins over older successes regardless of listing order", async () => {
  const older = { ...run, id: 451, status: "completed", conclusion: "success" };
  const middle = { ...run, id: 455, status: "completed", conclusion: "success" };
  const newest = { ...run, id: 460, run_attempt: 3 };
  for (const runs of [[middle, newest, older], [newest, older, middle], [older, middle, newest]]) {
    const f = fixture({ runs, jobs: [] });
    assert.equal(await readSourceVerification(sha, f.api), undefined);
    assert.equal(f.calls.length, 3);
    assert.equal(f.calls[2], `/repos/${repo}/actions/runs/460/attempts/3/jobs?per_page=100&page=1`);
  }
});

test("successful proof includes the exact source, run, attempt and job", async () => {
  const f = fixture();
  assert.deepEqual(await readSourceVerification(sha, f.api), { sha, runId: 456, attempt: 2, jobId: 789 });
  assert.equal(f.calls.length, 4);
  assert.equal(f.calls[2], `/repos/${repo}/actions/runs/456/attempts/2/jobs?per_page=100&page=1`);
  assert.equal(f.calls[3], `/repos/${repo}/actions/runs/456`);
});

test("each changed run identity on the final reread prevents proof", async (t) => {
  const changes = {
    repository: { full_name: "other/repo" }, head_repository: { full_name: "fork/repo" },
    workflow_id: 124, path: ".github/workflows/other.yml", head_sha: "b".repeat(40),
    head_branch: "feature", event: "workflow_dispatch", id: 457,
  };
  for (const [field, value] of Object.entries(changes)) {
    await t.test(field, async () => {
      const f = fixture({ current: { ...run, [field]: value } });
      assert.equal(await readSourceVerification(sha, f.api), undefined);
      assert.equal(f.calls.length, 4);
      assert.equal(f.calls[3], `/repos/${repo}/actions/runs/456`);
    });
  }
});
