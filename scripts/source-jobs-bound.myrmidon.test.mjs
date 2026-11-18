import assert from "node:assert/strict";
import test from "node:test";
import { readSourceVerification, sourceVerificationJob } from "./cloud-source-verification.mjs";

const sha = "a".repeat(40);
const workflow = { id: 123, path: ".github/workflows/cloud-readiness.yml" };
const run = {
  id: 456,
  workflow_id: workflow.id,
  path: workflow.path,
  run_attempt: 2,
  repository: { full_name: "paperclipai/paperclip" },
  head_repository: { full_name: "paperclipai/paperclip" },
  head_sha: sha,
  head_branch: "master",
  event: "push",
  status: "in_progress",
  conclusion: null,
};
const proof = {
  id: 789,
  name: sourceVerificationJob,
  run_id: run.id,
  run_attempt: run.run_attempt,
  head_sha: sha,
  status: "completed",
  conclusion: "success",
};

function jobsWithoutProof(count) {
  return Array.from({ length: count }, (_, index) => ({ id: 10_000 + index, name: `other job ${index}` }));
}

function fixture(pages) {
  const calls = [];
  const api = async (path) => {
    calls.push(path);
    if (path.endsWith("/workflows/cloud-readiness.yml")) return workflow;
    if (path.includes("/workflows/123/runs?")) return { total_count: 1, workflow_runs: [run] };
    if (path.endsWith("/runs/456")) return run;
    if (path.includes("/attempts/2/jobs?")) {
      const page = Number(new URL(`https://api.github.com${path}`).searchParams.get("page"));
      return pages[page] ?? { jobs: [] };
    }
    throw new Error(`Unexpected API path: ${path}`);
  };
  return { api, calls };
}

function jobPath(page) {
  return `/repos/paperclipai/paperclip/actions/runs/456/attempts/2/jobs?per_page=100&page=${page}`;
}

test("nine full pages and a partial tenth page return proof with exact reads", async () => {
  const pages = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [index + 1, { jobs: jobsWithoutProof(100) }]));
  pages[10] = { jobs: [proof, ...jobsWithoutProof(4)] };
  const { api, calls } = fixture(pages);

  assert.deepEqual(await readSourceVerification(sha, api), { sha, runId: 456, attempt: 2, jobId: 789 });
  assert.deepEqual(calls, [
    "/repos/paperclipai/paperclip/actions/workflows/cloud-readiness.yml",
    `/repos/paperclipai/paperclip/actions/workflows/123/runs?head_sha=${sha}&event=push&branch=master&per_page=100`,
    ...Array.from({ length: 10 }, (_, index) => jobPath(index + 1)),
    "/repos/paperclipai/paperclip/actions/runs/456",
  ]);
});

test("ten full pages fail incomplete without page eleven or a rerun read", async () => {
  const pages = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [index + 1, { jobs: jobsWithoutProof(100) }]));
  pages[1].jobs[0] = proof;
  const { api, calls } = fixture(pages);

  await assert.rejects(readSourceVerification(sha, api), /listing is incomplete/);
  assert.deepEqual(calls, [
    "/repos/paperclipai/paperclip/actions/workflows/cloud-readiness.yml",
    `/repos/paperclipai/paperclip/actions/workflows/123/runs?head_sha=${sha}&event=push&branch=master&per_page=100`,
    ...Array.from({ length: 10 }, (_, index) => jobPath(index + 1)),
  ]);
  assert.equal(calls.includes(jobPath(11)), false);
  assert.equal(calls.includes("/repos/paperclipai/paperclip/actions/runs/456"), false);
});

test("an empty terminal page is consumed once and cannot produce proof", async () => {
  const pages = Object.fromEntries(Array.from({ length: 3 }, (_, index) => [index + 1, { jobs: jobsWithoutProof(100) }]));
  pages[4] = { jobs: [] };
  const { api, calls } = fixture(pages);

  assert.equal(await readSourceVerification(sha, api), undefined);
  assert.deepEqual(calls.filter((path) => path.includes("/jobs?")), [1, 2, 3, 4].map(jobPath));
  assert.equal(calls.length, 6);
  assert.equal(calls.filter((path) => path === jobPath(4)).length, 1);
});

test("malformed jobs on a late page fail before proof selection", async () => {
  const pages = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [index + 1, { jobs: jobsWithoutProof(100) }]));
  pages[10] = { jobs: null };
  const { api, calls } = fixture(pages);

  await assert.rejects(readSourceVerification(sha, api), /job listing is malformed/);
  assert.deepEqual(calls.filter((path) => path.includes("/jobs?")), Array.from({ length: 10 }, (_, index) => jobPath(index + 1)));
  assert.equal(calls.some((path) => path.endsWith("/runs/456")), false);
});

test("proofs on different pages are ambiguous and do not reread the run", async () => {
  const pages = {
    1: { jobs: [proof, ...jobsWithoutProof(99)] },
    2: { jobs: [proof, ...jobsWithoutProof(2)] },
  };
  const { api, calls } = fixture(pages);

  await assert.rejects(readSourceVerification(sha, api), /ambiguous/);
  assert.deepEqual(calls.filter((path) => path.includes("/jobs?")), [jobPath(1), jobPath(2)]);
  assert.equal(calls.some((path) => path.endsWith("/runs/456")), false);
});
