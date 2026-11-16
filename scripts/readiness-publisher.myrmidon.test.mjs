import assert from "node:assert/strict";
import test from "node:test";
import { migratorPublished } from "./cloud-readiness.mjs";

const sha = "a".repeat(40);
const token = "synthetic-test-token";
const run = {
  id: 42, head_sha: sha, head_branch: "master",
  path: ".github/workflows/cloud-migrator-artifacts.yml",
  head_repository: { id: 1170821064, full_name: "paperclipai/paperclip" },
  event: "push", status: "completed", conclusion: "success",
};
const pending = { ...run, status: "in_progress", conclusion: null };
const failed = { ...run, conclusion: "failure" };

function fixture(pages) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    const response = pages[calls.length - 1];
    assert.ok(response, "unexpected request");
    return { ok: response.status !== 503, status: response.status ?? 200, json: async () => response.body };
  };
  return { fetch, calls };
}
function page(runs, total = runs.length) {
  return { body: { total_count: total, workflow_runs: runs } };
}
function assertCalls(calls, count) {
  assert.equal(calls.length, count);
  for (const [index, { url, options }] of calls.entries()) {
    const parsed = new URL(url);
    assert.equal(parsed.origin, "https://api.github.com");
    assert.equal(parsed.pathname, "/repos/paperclipai/paperclip/actions/workflows/cloud-migrator-artifacts.yml/runs");
    assert.deepEqual([...parsed.searchParams.entries()], [["branch", "master"], ["head_sha", sha], ["per_page", "100"], ["page", String(index + 1)]]);
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    assert.equal(options.headers.Accept, "application/vnd.github+json");
    assert.equal(options.redirect, "error");
  }
}

test("empty, successful and pending exact-source producers", async () => {
  for (const [runs, expected] of [[[], false], [[run], true], [[pending], false], [[{ ...run, event: "workflow_dispatch" }], true]]) {
    const f = fixture([page(runs)]);
    assert.equal(await migratorPublished(sha, f.fetch, token), expected);
    assertCalls(f.calls, 1);
  }
});

test("terminal failures reject with their identities", async () => {
  const f = fixture([page([failed, { ...failed, id: 43, conclusion: "cancelled" }])]);
  await assert.rejects(migratorPublished(sha, f.fetch, token), /42: failure, 43: cancelled/);
  assertCalls(f.calls, 1);
});

test("each producer must match the exact source and workflow identity", async () => {
  for (const override of [
    { head_sha: "b".repeat(40) }, { head_branch: "other" }, { path: ".github/workflows/other.yml" },
    { head_repository: { ...run.head_repository, id: 1 } },
    { head_repository: { ...run.head_repository, full_name: "fork/paperclip" } },
    { event: "pull_request" },
  ]) {
    const f = fixture([page([{ ...run, ...override }])]);
    await assert.rejects(migratorPublished(sha, f.fetch, token), /identity mismatch/);
    assertCalls(f.calls, 1);
  }
});

test("malformed responses and HTTP failures reject", async () => {
  for (const body of [
    { total_count: 1, workflow_runs: {} }, { total_count: -1, workflow_runs: [] },
    { total_count: 1.5, workflow_runs: [] }, { total_count: 0, workflow_runs: [run] },
    { total_count: 1, workflow_runs: [] },
  ]) {
    const f = fixture([{ body }]);
    await assert.rejects(migratorPublished(sha, f.fetch, token), /Invalid migrator producer response/);
    assertCalls(f.calls, 1);
  }
  const f = fixture([{ status: 503 }]);
  await assert.rejects(migratorPublished(sha, f.fetch, token), /HTTP 503/);
  assertCalls(f.calls, 1);
});

test("later success survives earlier failures or pending producers across pages", async () => {
  for (const earlier of [failed, pending]) {
    const f = fixture([page(Array(100).fill(earlier), 101), page([run], 101)]);
    assert.equal(await migratorPublished(sha, f.fetch, token), true);
    assertCalls(f.calls, 2);
  }
});

test("pending on the final page returns false despite prior failures", async () => {
  const f = fixture([page(Array(100).fill(failed), 101), page([pending], 101)]);
  assert.equal(await migratorPublished(sha, f.fetch, token), false);
  assertCalls(f.calls, 2);
});

test("ten full inconclusive pages reject without an eleventh request", async () => {
  const f = fixture(Array.from({ length: 10 }, () => page(Array(100).fill(pending), 1001)));
  await assert.rejects(migratorPublished(sha, f.fetch, token), /Too many migrator producer runs/);
  assertCalls(f.calls, 10);
});
