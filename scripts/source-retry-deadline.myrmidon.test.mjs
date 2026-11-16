import assert from "node:assert/strict";
import test from "node:test";
import { createActionsReader, waitForSourceVerification, sourceVerificationJob } from "./cloud-source-verification.mjs";

test("Retry-After cannot schedule a retry beyond the deadline", async () => {
  let clock = 0;
  let calls = 0;
  const waits = [];
  const api = createActionsReader({
    token: "fixture", now: () => clock, deadlineAt: () => 50, backoffMs: 10,
    log: () => {}, sleep: async (ms) => { waits.push(ms); clock += ms; },
    fetchImpl: async () => {
      calls += 1;
      return { ok: false, status: 429, headers: { get: () => "5" } };
    },
  });
  await assert.rejects(api("/fixture"), /HTTP 429/);
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
  assert.equal(clock, 0);
});

test("fresh budget covers equal boundary, slow fetch, network and body failures", async () => {
  for (const kind of ["equal", "fetch", "network", "body"]) {
    let clock = 0, calls = 0;
    const waits = [];
    const api = createActionsReader({ token: "fixture", now: () => clock, deadlineAt: () => 50,
      backoffMs: 10, log: () => {}, sleep: async (ms) => { waits.push(ms); clock += ms; },
      fetchImpl: async () => {
        calls++;
        if (kind === "network") { clock = 40; throw new Error("network"); }
        if (kind === "body") return { ok: true, json: async () => { clock = 40; throw new Error("body"); } };
        clock = kind === "fetch" ? 40 : 0;
        return { ok: false, status: 429, headers: { get: () => kind === "equal" ? "0.05" : null } };
      },
    });
    await assert.rejects(api("/fixture"), /HTTP 429|network|body/);
    assert.equal(calls, 1, kind);
    assert.deepEqual(waits, [], kind);
  }
});

test("ordinary backoff and Retry-After retry only within budget, including infinity", async () => {
  for (const [header, deadline, expected] of [[null, 50, 10], ["0.02", 50, 20], ["5", Infinity, 5000]]) {
    let clock = 0, calls = 0;
    const waits = [];
    const api = createActionsReader({ token: "fixture", now: () => clock, deadlineAt: () => deadline,
      backoffMs: 10, log: () => {}, sleep: async (ms) => { waits.push(ms); clock += ms; },
      fetchImpl: async () => ++calls === 1
        ? { ok: false, status: 429, headers: { get: () => header } }
        : { ok: true, json: async () => ({ value: "proof" }) },
    });
    assert.deepEqual(await api("/fixture"), { value: "proof" });
    assert.equal(calls, 2);
    assert.deepEqual(waits, [expected]);
  }
});

test("a late body and an oversleep cannot return data or start another request", async () => {
  for (const lateBody of [true, false]) {
    let clock = 0, calls = 0;
    const api = createActionsReader({ token: "fixture", now: () => clock, deadlineAt: () => 50,
      backoffMs: 10, log: () => {}, sleep: async () => { clock = 50; },
      fetchImpl: async () => { calls++; return lateBody
        ? { ok: true, json: async () => { clock = 50; return { value: "late" }; } }
        : { ok: false, status: 502, headers: { get: () => null } }; },
    });
    await assert.rejects(api("/fixture"), /deadline/);
    assert.equal(calls, 1);
  }
});

test("request timeout is limited by remaining budget and infinity retains 30 seconds", async () => {
  const original = AbortSignal.timeout;
  const durations = [];
  AbortSignal.timeout = (ms) => { durations.push(ms); return original(ms); };
  try {
    for (const deadline of [50, Infinity]) {
      const api = createActionsReader({ token: "fixture", now: () => 0, deadlineAt: () => deadline,
        fetchImpl: async () => ({ ok: true, json: async () => ({ id: 7 }) }) });
      assert.deepEqual(await api("/fixture"), { id: 7 });
    }
    assert.deepEqual(durations, [50, 30000]);
  } finally { AbortSignal.timeout = original; }
});

test("polling never returns proof that arrives at the deadline", async () => {
  const sha = "a".repeat(40);
  const run = { id: 2, workflow_id: 1, path: ".github/workflows/cloud-readiness.yml", run_attempt: 1,
    repository: { full_name: "paperclipai/paperclip" }, head_repository: { full_name: "paperclipai/paperclip" },
    head_sha: sha, head_branch: "master", event: "push" };
  let clock = 0, calls = 0;
  const api = async (path) => {
    calls++;
    if (path.endsWith("cloud-readiness.yml")) return { id: 1, path: run.path };
    if (path.includes("/workflows/1/runs?")) return { total_count: 1, workflow_runs: [run] };
    if (path.includes("/jobs?")) return { jobs: [{ id: 3, name: sourceVerificationJob, run_id: 2,
      run_attempt: 1, head_sha: sha, status: "completed", conclusion: "success" }] };
    clock = 50;
    return run;
  };
  await assert.rejects(waitForSourceVerification(sha, { api, now: () => clock, timeoutMs: 50, log: () => {} }), /timed out/);
  assert.equal(calls, 4);
});
