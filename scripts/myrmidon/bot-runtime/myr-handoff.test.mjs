import test from "node:test";
import assert from "node:assert/strict";
import { run, isMatchingPrWorkProduct } from "../../../docker/bot-runtime/myr-ws/lib/handoff.js";

const REVIEW_POLICY = {
  mode: "normal",
  stages: [{ id: "st-1", type: "review", approvalsNeeded: 1, participants: [{ id: "p-1", type: "agent", agentId: "reviewer-x", userId: null }] }],
};

test("myr-handoff requires --issue and --summary", async () => {
  const res = await run([]);
  assert.equal(res.exitCode, 1);
  assert.match(res.stderr, /--issue and --summary are required/);
});

test("myr-handoff fails if git branch cannot be determined", async () => {
  const deps = {
    env: { PAPERCLIP_API_KEY: "secret" },
    fetch: async () => ({
      ok: true,
      json: async () => ({ id: "issue-uuid-123", identifier: "OPE-123", executionPolicy: REVIEW_POLICY }),
    }),
    runCommand: (cmd, args) => {
      if (cmd === "git" && args[0] === "branch") {
        return { status: 1, stdout: "", stderr: "not a git repo" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  };
  const res = await run(["--issue", "OPE-123", "--summary", "done"], deps);
  assert.equal(res.exitCode, 1);
  assert.match(res.stderr, /failed at step git_branch/);
});

test("myr-handoff fails if git push fails", async () => {
  const deps = {
    env: { PAPERCLIP_API_KEY: "secret" },
    fetch: async () => ({
      ok: true,
      json: async () => ({ id: "issue-uuid-123", identifier: "OPE-123", executionPolicy: REVIEW_POLICY }),
    }),
    runCommand: (cmd, args) => {
      if (cmd === "git" && args[0] === "branch") {
        return { status: 0, stdout: "bot/OPE-123\n", stderr: "" };
      }
      if (cmd === "git" && args[0] === "rev-parse") {
        return { status: 0, stdout: "deadbeef123456\n", stderr: "" };
      }
      if (cmd === "git" && args[0] === "push") {
        return { status: 1, stdout: "", stderr: "remote rejected" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  };
  const res = await run(["--issue", "OPE-123", "--summary", "done"], deps);
  assert.equal(res.exitCode, 1);
  assert.match(res.stderr, /failed at step git_push/);
});

test("myr-handoff creates new PR if none exists and patches issue to in_review", async () => {
  const commandsRun = [];
  const fetchedUrls = [];
  let patchedPayload = null;

  const deps = {
    env: {
      PAPERCLIP_API_KEY: "secret",
      PAPERCLIP_API_URL: "http://paperclip-test:3100",
      PAPERCLIP_RUN_ID: "run-test-id",
    },
    runCommand: (cmd, args) => {
      commandsRun.push([cmd, ...args]);
      if (cmd === "git" && args[0] === "branch") {
        return { status: 0, stdout: "bot/OPE-123\n", stderr: "" };
      }
      if (cmd === "git" && args[0] === "rev-parse") {
        return { status: 0, stdout: "0123456789abcdef\n", stderr: "" };
      }
      if (cmd === "git" && args[0] === "push") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
        return { status: 1, stdout: "", stderr: "no pull requests found" };
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "create") {
        return { status: 0, stdout: "https://github.com/itkadr-git/myrmidon/pull/42\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    fetch: async (url, opts) => {
      fetchedUrls.push(url);
      if (url.endsWith("/api/issues/OPE-123")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "issue-uuid-123", identifier: "OPE-123", executionPolicy: REVIEW_POLICY }),
        };
      }
      if (url.endsWith("/api/issues/issue-uuid-123") && opts.method === "PATCH") {
        patchedPayload = JSON.parse(opts.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "issue-uuid-123", status: "in_review" }),
        };
      }
      if (url.endsWith("/api/issues/issue-uuid-123/work-products")) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              id: "wp-1",
              kind: "pull_request",
              metadata: { number: 42, url: "https://github.com/itkadr-git/myrmidon/pull/42" },
            },
          ],
        };
      }
      return { ok: false, status: 404, text: async () => "not found" };
    },
  };

  const res = await run(["--issue", "OPE-123", "--summary", "acceptance confirmed"], deps);
  assert.equal(res.exitCode, 0);
  assert.equal(res.stdout, "PR #42 sha 0123456789abcdef status in_review bound yes\n");
  assert.equal(patchedPayload.status, "in_review");
  assert.equal(patchedPayload.comment, "acceptance confirmed");
  assert.deepEqual(Object.keys(patchedPayload).sort(), ["comment", "status"]);
  assert.equal("executionPolicy" in patchedPayload, false);
});

test("myr-handoff reuses existing PR and updates title if needed", async () => {
  const commandsRun = [];
  const deps = {
    env: {
      PAPERCLIP_API_KEY: "secret",
      PAPERCLIP_API_URL: "http://paperclip-test:3100",
    },
    runCommand: (cmd, args) => {
      commandsRun.push([cmd, ...args]);
      if (cmd === "git" && args[0] === "branch") {
        return { status: 0, stdout: "bot/OPE-999\n", stderr: "" };
      }
      if (cmd === "git" && args[0] === "rev-parse") {
        return { status: 0, stdout: "feedbeef999\n", stderr: "" };
      }
      if (cmd === "git" && args[0] === "push") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
        return {
          status: 0,
          stdout: JSON.stringify({ number: 43, state: "OPEN", title: "some work", url: "https://github.com/itkadr-git/myrmidon/pull/43" }),
          stderr: "",
        };
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "edit") {
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    fetch: async (url, opts) => {
      if (url.endsWith("/api/issues/OPE-999")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "issue-uuid-999", identifier: "OPE-999", executionPolicy: REVIEW_POLICY }),
        };
      }
      if (url.endsWith("/api/issues/issue-uuid-999") && opts.method === "PATCH") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "issue-uuid-999", status: "in_review" }),
        };
      }
      if (url.endsWith("/api/issues/issue-uuid-999/work-products")) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              id: "wp-43",
              kind: "pull_request",
              metadata: { number: 43 },
              url: "https://github.com/itkadr-git/myrmidon/pull/43",
            },
          ],
        };
      }
      return { ok: false, status: 404, text: async () => "not found" };
    },
  };

  const res = await run(["--issue", "OPE-999", "--summary", "second run"], deps);
  assert.equal(res.exitCode, 0);
  assert.equal(res.stdout, "PR #43 sha feedbeef999 status in_review bound yes\n");
  const editCmd = commandsRun.find((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "edit");
  assert.ok(editCmd);
  assert.equal(editCmd[4], "--title");
  assert.equal(editCmd[5], "OPE-999: some work");
});

test("myr-handoff fails on admission rejection before creating PR", async () => {
  const commandsRun = [];
  const depsClosed = {
    env: { PAPERCLIP_API_KEY: "secret" },
    runCommand: (cmd, args) => {
      commandsRun.push([cmd, ...args]);
      return { status: 0, stdout: "", stderr: "" };
    },
    fetch: async () => ({
      ok: true,
      json: async () => ({ id: "issue-uuid-1", identifier: "OPE-1", status: "done" }),
    }),
  };
  const resClosed = await run(["--issue", "OPE-1", "--summary", "done"], depsClosed);
  assert.equal(resClosed.exitCode, 1);
  assert.match(resClosed.stderr, /failed at step issue_admission/);
  assert.match(resClosed.stderr, /cannot transition closed issue/);
  assert.equal(commandsRun.length, 0);

  const depsHumanOnly = {
    env: { PAPERCLIP_API_KEY: "secret" },
    runCommand: (cmd, args) => {
      commandsRun.push([cmd, ...args]);
      return { status: 0, stdout: "", stderr: "" };
    },
    fetch: async () => ({
      ok: true,
      json: async () => ({ id: "issue-uuid-1", identifier: "OPE-1", status: "in_progress", reviewPolicy: "human_only" }),
    }),
  };
  const resHumanOnly = await run(["--issue", "OPE-1", "--summary", "done"], depsHumanOnly);
  assert.equal(resHumanOnly.exitCode, 1);
  assert.match(resHumanOnly.stderr, /failed at step issue_admission/);
  assert.match(resHumanOnly.stderr, /human_only/);
});

test("myr-handoff fails if gh pr edit fails when updating existing PR title", async () => {
  const deps = {
    env: { PAPERCLIP_API_KEY: "secret" },
    runCommand: (cmd, args) => {
      if (cmd === "git" && args[0] === "branch") {
        return { status: 0, stdout: "bot/OPE-123\n", stderr: "" };
      }
      if (cmd === "git" && args[0] === "rev-parse") {
        return { status: 0, stdout: "0123456789abcdef\n", stderr: "" };
      }
      if (cmd === "git" && args[0] === "push") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
        return {
          status: 0,
          stdout: JSON.stringify({ number: 50, state: "OPEN", title: "old title without key", url: "https://github.com/itkadr-git/myrmidon/pull/50" }),
          stderr: "",
        };
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "edit") {
        return { status: 1, stdout: "", stderr: "graphql error: permission denied" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    fetch: async () => ({
      ok: true,
      json: async () => ({ id: "issue-uuid-123", identifier: "OPE-123", executionPolicy: REVIEW_POLICY }),
    }),
  };
  const res = await run(["--issue", "OPE-123", "--summary", "done"], deps);
  assert.equal(res.exitCode, 1);
  assert.match(res.stderr, /failed at step gh_pr_edit/);
  assert.match(res.stderr, /permission denied/);
});

test("myr-handoff fails if PR binding fails when work product cannot be created, leaving status unchanged", async () => {
  let patchCalled = false;
  let issueRecord = {
    id: "issue-uuid-55",
    identifier: "OPE-55",
    status: "in_progress",
    executionPolicy: REVIEW_POLICY,
  };
  const deps = {
    env: {
      PAPERCLIP_API_KEY: "secret",
      PAPERCLIP_API_URL: "http://paperclip-test:3100",
    },
    runCommand: (cmd, args) => {
      if (cmd === "git" && args[0] === "branch") return { status: 0, stdout: "bot/OPE-55\n", stderr: "" };
      if (cmd === "git" && args[0] === "rev-parse") return { status: 0, stdout: "abcdef9999\n", stderr: "" };
      if (cmd === "git" && args[0] === "push") return { status: 0, stdout: "", stderr: "" };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
        return {
          status: 0,
          stdout: JSON.stringify({ number: 55, state: "OPEN", title: "OPE-55: test", url: "https://github.com/itkadr-git/myrmidon/pull/55" }),
          stderr: "",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    fetch: async (url, opts) => {
      if (url.endsWith("/api/issues/OPE-55")) {
        return { ok: true, json: async () => ({ ...issueRecord }) };
      }
      if (url.endsWith("/api/issues/issue-uuid-55") && opts && opts.method === "PATCH") {
        patchCalled = true;
        issueRecord = { ...issueRecord, ...JSON.parse(opts.body) };
        return { ok: true, json: async () => issueRecord };
      }
      if (url.endsWith("/api/issues/issue-uuid-55/work-products") && (!opts || !opts.method || opts.method === "GET")) {
        return { ok: true, json: async () => [] };
      }
      if (url.endsWith("/api/issues/issue-uuid-55/work-products") && opts.method === "POST") {
        return { ok: false, status: 500, text: async () => "Internal server error" };
      }
      return { ok: false, status: 404, text: async () => "not found" };
    },
  };

  const res = await run(["--issue", "OPE-55", "--summary", "fail binding"], deps);
  assert.equal(res.exitCode, 1);
  assert.match(res.stderr, /failed at step work_product_binding/);
  assert.match(res.stderr, /explicit binding failed/);
  assert.equal(patchCalled, false, "issue status PATCH must NOT be called when work product binding fails");
  assert.equal(issueRecord.status, "in_progress", "issue status must remain unchanged when work product binding fails");
});

test("myr-handoff fails if PR verification fails and leaves status unchanged", async () => {
  let patchCalled = false;
  let issueRecord = {
    id: "issue-uuid-56",
    identifier: "OPE-56",
    status: "in_progress",
    executionPolicy: REVIEW_POLICY,
  };
  const deps = {
    env: {
      PAPERCLIP_API_KEY: "secret",
      PAPERCLIP_API_URL: "http://paperclip-test:3100",
    },
    runCommand: (cmd, args) => {
      if (cmd === "git" && args[0] === "branch") return { status: 0, stdout: "bot/OPE-56\n", stderr: "" };
      if (cmd === "git" && args[0] === "rev-parse") return { status: 0, stdout: "11223344\n", stderr: "" };
      if (cmd === "git" && args[0] === "push") return { status: 0, stdout: "", stderr: "" };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
        return {
          status: 0,
          stdout: JSON.stringify({ number: 56, state: "OPEN", title: "OPE-56: test", url: "https://github.com/itkadr-git/myrmidon/pull/56" }),
          stderr: "",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    fetch: async (url, opts) => {
      if (url.endsWith("/api/issues/OPE-56")) {
        return { ok: true, json: async () => ({ ...issueRecord }) };
      }
      if (url.endsWith("/api/issues/issue-uuid-56") && opts && opts.method === "PATCH") {
        patchCalled = true;
        issueRecord = { ...issueRecord, ...JSON.parse(opts.body) };
        return { ok: true, json: async () => issueRecord };
      }
      if (url.endsWith("/api/issues/issue-uuid-56/work-products")) {
        return { ok: false, status: 502, text: async () => "Bad Gateway" };
      }
      return { ok: false, status: 404, text: async () => "not found" };
    },
  };

  const res = await run(["--issue", "OPE-56", "--summary", "fail verify"], deps);
  assert.equal(res.exitCode, 1);
  assert.match(res.stderr, /failed at step work_product_verify/);
  assert.match(res.stderr, /HTTP 502/);
  assert.equal(patchCalled, false, "issue status PATCH must NOT be called when work product verification fails");
  assert.equal(issueRecord.status, "in_progress", "issue status must remain unchanged when work product verification fails");
});

function makeDeps({ patchStatus = 200, getStatus = 200, prView, commandsRun = [] } = {}) {
  return {
    env: { PAPERCLIP_API_KEY: "secret", PAPERCLIP_API_URL: "http://paperclip-test:3100" },
    runCommand: (cmd, args) => {
      commandsRun.push([cmd, ...args]);
      if (cmd === "git" && args[0] === "branch") return { status: 0, stdout: "bot/OPE-5\n", stderr: "" };
      if (cmd === "git" && args[0] === "rev-parse") return { status: 0, stdout: "abc123\n", stderr: "" };
      if (cmd === "git" && args[0] === "push") return { status: 0, stdout: "", stderr: "" };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
        return prView || { status: 1, stdout: "", stderr: "no pull requests found" };
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "create") {
        return { status: 0, stdout: "https://github.com/itkadr-git/myrmidon/pull/77\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    fetch: async (url, opts) => {
      if (url.endsWith("/api/issues/OPE-5")) {
        if (getStatus !== 200) return { ok: false, status: getStatus, text: async () => "x".repeat(1000) };
        return { ok: true, status: 200, json: async () => ({ id: "issue-uuid-5", identifier: "OPE-5", executionPolicy: REVIEW_POLICY }) };
      }
      if (url.endsWith("/api/issues/issue-uuid-5") && opts.method === "PATCH") {
        if (patchStatus !== 200) return { ok: false, status: patchStatus, text: async () => "unprocessable" };
        return { ok: true, status: 200, json: async () => ({ id: "issue-uuid-5", status: "in_review" }) };
      }
      if (url.endsWith("/api/issues/issue-uuid-5/work-products") && (!opts || !opts.method || opts.method === "GET")) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              id: "wp-77",
              kind: "pull_request",
              metadata: { number: 77 },
              url: "https://github.com/itkadr-git/myrmidon/pull/77",
            },
          ],
        };
      }
      return { ok: false, status: 404, text: async () => "not found" };
    },
  };
}

test("myr-handoff reports issue_patch HTTP 422 and exits non-zero with partial handoff info", async () => {
  const res = await run(["--issue", "OPE-5", "--summary", "s"], makeDeps({ patchStatus: 422 }));
  assert.notEqual(res.exitCode, 0);
  assert.match(res.stderr, /issue_patch/);
  assert.match(res.stderr, /HTTP 422/);
  assert.match(res.stderr, /PR #77 sha abc123/);
});

test("myr-handoff reports issue_get HTTP 500 (not 'not found') with truncated body", async () => {
  const res = await run(["--issue", "OPE-5", "--summary", "s"], makeDeps({ getStatus: 500 }));
  assert.notEqual(res.exitCode, 0);
  assert.match(res.stderr, /issue_get: HTTP 500/);
  assert.doesNotMatch(res.stderr, /not found/);
  assert.ok(res.stderr.length < 1200);
  assert.ok(res.stderr.includes("x".repeat(1000)));
  assert.ok(!res.stderr.includes("x".repeat(1001)));
});

test("myr-handoff creates a new PR when the branch only has a merged PR", async () => {
  const commandsRun = [];
  const deps = makeDeps({
    commandsRun,
    prView: {
      status: 0,
      stdout: JSON.stringify({ number: 10, state: "MERGED", title: "OPE-5: old", url: "https://github.com/itkadr-git/myrmidon/pull/10" }),
      stderr: "",
    },
  });
  const res = await run(["--issue", "OPE-5", "--summary", "s"], deps);
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, /^PR #77 /);
  assert.ok(commandsRun.some((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "create"));
});

test("myr-handoff reports a fetch timeout with non-zero exit", async () => {
  const deps = makeDeps();
  deps.fetch = async () => {
    const e = new Error("aborted");
    e.name = "TimeoutError";
    throw e;
  };
  const res = await run(["--issue", "OPE-5", "--summary", "s"], deps);
  assert.notEqual(res.exitCode, 0);
  assert.match(res.stderr, /timed out/);
});


function policyDeps(policy, sink) {
  const deps = makeDeps();
  const baseFetch = deps.fetch;
  deps.fetch = async (url, opts) => {
    if (url.endsWith("/api/issues/OPE-5")) {
      return { ok: true, status: 200, json: async () => ({ id: "issue-uuid-5", identifier: "OPE-5", executionPolicy: policy }) };
    }
    if (opts && opts.method === "PATCH") sink.patches.push(JSON.parse(opts.body));
    return baseFetch(url, opts);
  };
  const baseRun = deps.runCommand;
  deps.runCommand = (cmd, args) => {
    sink.commands.push([cmd, ...args]);
    return baseRun(cmd, args);
  };
  return deps;
}

test("myr-handoff keeps an existing review stage: PATCH has no executionPolicy", async () => {
  const sink = { patches: [], commands: [] };
  const res = await run(["--issue", "OPE-5", "--summary", "s"], policyDeps(REVIEW_POLICY, sink));
  assert.equal(res.exitCode, 0);
  assert.equal(sink.patches.length, 1);
  assert.equal("executionPolicy" in sink.patches[0], false);
});

test("myr-handoff rejects --reviewer argument", async () => {
  const sink = { patches: [], commands: [] };
  const res = await run(["--issue", "OPE-5", "--summary", "s", "--reviewer", "agent-r1"], policyDeps(REVIEW_POLICY, sink));
  assert.notEqual(res.exitCode, 0);
  assert.match(res.stderr, /--reviewer is not supported; use the issue's configured review workflow/);
  assert.equal(sink.patches.length, 0);
  assert.equal(sink.commands.length, 0);
});

test("myr-handoff without review stage: bare in_review PATCH, executionPolicy never written", async () => {
  const sink = { patches: [], commands: [] };
  const policy = {
    mode: "normal",
    stages: [{ id: "st-a", type: "approval", approvalsNeeded: 1, participants: [{ type: "user", userId: "u1" }] }],
  };
  const res = await run(["--issue", "OPE-5", "--summary", "s"], policyDeps(policy, sink));
  assert.equal(res.exitCode, 0);
  assert.equal(sink.patches.length, 1);
  assert.deepEqual(Object.keys(sink.patches[0]).sort(), ["comment", "status"]);
  assert.equal(sink.patches[0].status, "in_review");
});

test("myr-handoff board refusal for an issue without review stage is shown, status unchanged", async () => {
  const sink = { patches: [], commands: [] };
  const deps = policyDeps(null, sink);
  let record = { id: "issue-uuid-5", status: "in_progress" };
  const baseFetch = deps.fetch;
  deps.fetch = async (url, opts) => {
    if (opts && opts.method === "PATCH" && url.endsWith("/api/issues/issue-uuid-5")) {
      sink.patches.push(JSON.parse(opts.body));
      return { ok: false, status: 422, text: async () => "no review stage configured for this issue" };
    }
    return baseFetch(url, opts);
  };
  const res = await run(["--issue", "OPE-5", "--summary", "s"], deps);
  assert.equal(res.exitCode, 1);
  assert.match(res.stderr, /issue_patch/);
  assert.match(res.stderr, /HTTP 422 no review stage configured for this issue/);
  assert.equal(sink.patches.some((p) => "executionPolicy" in p), false);
  assert.equal(record.status, "in_progress");
});

test("myr-handoff refuses to hand off from a protected branch and does not push", async () => {
  const commands = [];
  const deps = makeDeps({ commandsRun: commands });
  const base = deps.runCommand;
  deps.runCommand = (cmd, args) =>
    cmd === "git" && args[0] === "branch" ? { status: 0, stdout: "main\n", stderr: "" } : base(cmd, args);
  const res = await run(["--issue", "OPE-5", "--summary", "s"], deps);
  assert.equal(res.exitCode, 1);
  assert.match(res.stderr, /only bot\/\* branches are accepted/);
  assert.equal(commands.some((c) => c[0] === "git" && c[1] === "push"), false);
});

test("myr-handoff treats regex metacharacters in --issue literally when cleaning an existing PR title", async () => {
  const commands = [];
  const deps = makeDeps({
    commandsRun: commands,
    prView: { status: 0, stdout: JSON.stringify({ number: 77, state: "OPEN", title: "old title", url: "https://github.com/itkadr-git/myrmidon/pull/77" }), stderr: "" },
  });
  const baseFetch = deps.fetch;
  deps.fetch = async (url, opts) =>
    url.endsWith("/api/issues/(")
      ? { ok: true, status: 200, json: async () => ({ id: "issue-uuid-5", identifier: "OPE-5", executionPolicy: REVIEW_POLICY }) }
      : baseFetch(url, opts);
  const res = await run(["--issue", "(", "--summary", "s"], deps);
  assert.equal(res.exitCode, 0, res.stderr);
  const edit = commands.find((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "edit");
  assert.equal(edit[edit.indexOf("--title") + 1], "OPE-5: old title");
});

test("myr-handoff titles the PR with the issue key, not the UUID passed in --issue", async () => {
  const uuid = "123e4567-e89b-12d3-a456-426614174000";
  const commands = [];
  const deps = makeDeps({ commandsRun: commands });
  const baseFetch = deps.fetch;
  deps.fetch = async (url, opts) => {
    if (url.endsWith(`/api/issues/${uuid}`)) {
      return { ok: true, status: 200, json: async () => ({ id: uuid, identifier: "OPE-9999", executionPolicy: REVIEW_POLICY }) };
    }
    if (url.endsWith(`/api/issues/${uuid}/work-products`)) {
      return { ok: true, status: 200, json: async () => [] };
    }
    if (opts && opts.method === "PATCH") return { ok: true, status: 200, json: async () => ({}) };
    return baseFetch(url, opts);
  };
  const res = await run(["--issue", uuid, "--summary", "s"], deps);
  assert.equal(res.exitCode, 0);
  const create = commands.find((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "create");
  assert.ok(create);
  const title = create[create.indexOf("--title") + 1];
  assert.match(title, /OPE-9999/);
  assert.ok(!title.includes(uuid));
});

test("myr-handoff reuses existing PR and updates title with issue key, stripping raw UUID when --issue is UUID", async () => {
  const uuid = "123e4567-e89b-12d3-a456-426614174000";
  const commands = [];
  const deps = makeDeps({
    commandsRun: commands,
    prView: {
      status: 0,
      stdout: JSON.stringify({
        number: 88,
        state: "OPEN",
        title: `${uuid}: previous feature branch`,
        url: "https://github.com/itkadr-git/myrmidon/pull/88",
      }),
      stderr: "",
    },
  });
  const baseFetch = deps.fetch;
  deps.fetch = async (url, opts) => {
    if (url.endsWith(`/api/issues/${uuid}`)) {
      return { ok: true, status: 200, json: async () => ({ id: uuid, identifier: "OPE-9999", executionPolicy: REVIEW_POLICY }) };
    }
    if (url.endsWith(`/api/issues/${uuid}/work-products`)) {
      return {
        ok: true,
        status: 200,
        json: async () => [{ id: "wp-88", kind: "pull_request", metadata: { number: 88 } }],
      };
    }
    if (opts && opts.method === "PATCH") return { ok: true, status: 200, json: async () => ({}) };
    return baseFetch(url, opts);
  };
  const res = await run(["--issue", uuid, "--summary", "s"], deps);
  assert.equal(res.exitCode, 0);
  const edit = commands.find((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "edit");
  assert.ok(edit);
  const title = edit[edit.indexOf("--title") + 1];
  assert.equal(title, "OPE-9999: previous feature branch");
  assert.ok(!title.includes(uuid));
});

test("myr-handoff fails on admission rejection with clear error and leaves status unchanged", async () => {
  const commands = [];
  let issueRecord = {
    id: "issue-uuid-closed",
    identifier: "OPE-777",
    status: "done",
    reviewPolicy: "standard",
    executionPolicy: REVIEW_POLICY,
  };

  const deps = {
    env: { PAPERCLIP_API_KEY: "secret", PAPERCLIP_API_URL: "http://paperclip-test:3100" },
    runCommand: (cmd, args) => {
      commands.push([cmd, ...args]);
      return { status: 0, stdout: "", stderr: "" };
    },
    fetch: async (url, opts) => {
      if (url.endsWith("/api/issues/OPE-777")) {
        return { ok: true, status: 200, json: async () => ({ ...issueRecord }) };
      }
      if (opts && opts.method === "PATCH") {
        issueRecord = { ...issueRecord, ...JSON.parse(opts.body) };
        return { ok: true, status: 200, json: async () => issueRecord };
      }
      return { ok: false, status: 404 };
    },
  };

  // Case 1: Closed issue (status: done) -> early admission fails, status remains done
  const resDone = await run(["--issue", "OPE-777", "--summary", "try handoff"], deps);
  assert.equal(resDone.exitCode, 1);
  assert.match(resDone.stderr, /failed at step issue_admission/);
  assert.match(resDone.stderr, /cannot transition closed issue \(status: done\) to in_review/);
  assert.equal(issueRecord.status, "done"); // status NOT modified
  assert.equal(commands.length, 0); // no git push, no gh pr create

  // Case 2: Human only reviewPolicy -> early admission fails, status remains in_progress
  issueRecord.status = "in_progress";
  issueRecord.reviewPolicy = "human_only";
  const resHumanOnly = await run(["--issue", "OPE-777", "--summary", "try handoff"], deps);
  assert.equal(resHumanOnly.exitCode, 1);
  assert.match(resHumanOnly.stderr, /failed at step issue_admission/);
  assert.match(resHumanOnly.stderr, /issue reviewPolicy is human_only/);
  assert.equal(issueRecord.status, "in_progress"); // status NOT modified
  assert.equal(commands.length, 0);

  // Case 3: server rejects the PATCH (422 invalid_issue_disposition) -> stateful check: status unchanged
  const serverIssue = { id: "issue-uuid-5", identifier: "OPE-5", status: "in_progress", executionPolicy: REVIEW_POLICY };
  const patchAttempts = [];
  const depsLate = makeDeps({ commandsRun: [] });
  const baseFetch = depsLate.fetch;
  depsLate.fetch = async (url, opts) => {
    if (url.endsWith("/api/issues/OPE-5")) return { ok: true, status: 200, json: async () => ({ ...serverIssue }) };
    if (url.endsWith("/api/issues/issue-uuid-5") && opts && opts.method === "PATCH") {
      patchAttempts.push(JSON.parse(opts.body));
      // a rejecting server leaves the record untouched
      return { ok: false, status: 422, text: async () => "invalid_issue_disposition: missing green CI" };
    }
    return baseFetch(url, opts);
  };
  const statusBefore = serverIssue.status;
  const resLate = await run(["--issue", "OPE-5", "--summary", "try handoff"], depsLate);
  assert.equal(resLate.exitCode, 1);
  assert.match(resLate.stderr, /failed at step issue_patch/);
  assert.match(resLate.stderr, /HTTP 422 invalid_issue_disposition: missing green CI/);
  assert.match(resLate.stderr, /PR #77 sha abc123/);
  assert.equal(patchAttempts.length, 1);
  assert.equal(patchAttempts[0].status, "in_review");
  assert.equal("executionPolicy" in patchAttempts[0], false);
  // re-read the issue through the same API: status must be what it was before the rejected PATCH
  const reread = await (await depsLate.fetch("http://paperclip-test:3100/api/issues/OPE-5")).json();
  assert.equal(reread.status, statusBefore);
  assert.equal(reread.status, "in_progress");
});

// ---- strict flags -------------------------------------------------------------------------------
for (const [name, args] of [
  ["--summary without value", ["--issue", "OPE-5", "--summary"]],
  ["--issue without value", ["--summary", "s", "--issue"]],
  ["empty --summary=", ["--issue", "OPE-5", "--summary="]],
  ["blank --issue", ["--issue", "  ", "--summary", "s"]],
  ["unknown flag --base", ["--issue", "OPE-5", "--summary", "s", "--base", "main"]],
  ["unknown flag --title", ["--issue", "OPE-5", "--summary", "s", "--title", "x"]],
  ["stray positional", ["--issue", "OPE-5", "--summary", "s", "extra"]],
  ["empty --reviewer=", ["--issue", "OPE-5", "--summary", "s", "--reviewer="]],
]) {
  test(`myr-handoff rejects ${name} before any command or request`, async () => {
    const sink = { patches: [], commands: [] };
    const deps = policyDeps(REVIEW_POLICY, sink);
    let fetched = 0;
    const baseFetch = deps.fetch;
    deps.fetch = async (u, o) => { fetched++; return baseFetch(u, o); };
    const res = await run(args, deps);
    assert.equal(res.exitCode, 1);
    assert.notEqual(res.stderr, "");
    assert.equal(fetched, 0);
    assert.equal(sink.commands.length, 0);
    assert.equal(sink.patches.length, 0);
  });
}

// ---- exact matching -----------------------------------------------------------------------------
test("isMatchingPrWorkProduct: #31 does not match #317, externalId and URL do", () => {
  const pr = (extra) => ({ type: "pull_request", ...extra });
  assert.equal(isMatchingPrWorkProduct(pr({ title: "PR #317" }), 31, null), false);
  assert.equal(isMatchingPrWorkProduct(pr({ title: "PR #31" }), 31, null), true);
  assert.equal(isMatchingPrWorkProduct(pr({ title: "PR #31: fix" }), 31, null), true);
  assert.equal(isMatchingPrWorkProduct(pr({ externalId: "31" }), 31, null), true);
  assert.equal(isMatchingPrWorkProduct(pr({ externalId: "317" }), 31, null), false);
  assert.equal(isMatchingPrWorkProduct(pr({ url: "https://github.com/o/r/pull/317" }), 31, null), false);
  assert.equal(isMatchingPrWorkProduct(pr({ url: "https://github.com/o/r/pull/31" }), 31, null), true);
});

function titleCase(existingTitle, identifier) {
  const commands = [];
  const deps = makeDeps({
    commandsRun: commands,
    prView: { status: 0, stdout: JSON.stringify({ number: 77, state: "OPEN", title: existingTitle, url: "https://github.com/itkadr-git/myrmidon/pull/77" }), stderr: "" },
  });
  const baseFetch = deps.fetch;
  deps.fetch = async (url, opts) =>
    url.endsWith("/api/issues/OPE-5")
      ? { ok: true, status: 200, json: async () => ({ id: "issue-uuid-5", identifier, executionPolicy: REVIEW_POLICY }) }
      : baseFetch(url, opts);
  return { commands, deps };
}

test("myr-handoff: OPE-130 in an existing title is not OPE-1307 (title gets rewritten)", async () => {
  const { commands, deps } = titleCase("OPE-130: other work", "OPE-1307");
  const res = await run(["--issue", "OPE-5", "--summary", "s"], deps);
  assert.equal(res.exitCode, 0, res.stderr);
  const edit = commands.find((c) => c[0] === "gh" && c[2] === "edit");
  assert.equal(edit[edit.indexOf("--title") + 1], "OPE-1307: other work");
});

test("myr-handoff: foreign key at the start of the title is replaced, not stacked", async () => {
  const { commands, deps } = titleCase("OPE-1: fix the thing", "OPE-2");
  const res = await run(["--issue", "OPE-5", "--summary", "s"], deps);
  assert.equal(res.exitCode, 0, res.stderr);
  const edit = commands.find((c) => c[0] === "gh" && c[2] === "edit");
  assert.equal(edit[edit.indexOf("--title") + 1], "OPE-2: fix the thing");
});

test("myr-handoff: title that already starts with the own key is left alone", async () => {
  const { commands, deps } = titleCase("OPE-2: fix the thing", "OPE-2");
  const res = await run(["--issue", "OPE-5", "--summary", "s"], deps);
  assert.equal(res.exitCode, 0, res.stderr);
  assert.equal(commands.some((c) => c[0] === "gh" && c[2] === "edit"), false);
});

// ---- branch ---------------------------------------------------------------------------------------
for (const b of ["main", "master", "rel/1.6.6-fixes", "feature/x", "ope-13099-foo"]) {
  test(`myr-handoff rejects branch ${b}`, async () => {
    const commands = [];
    const deps = makeDeps({ commandsRun: commands });
    const base = deps.runCommand;
    deps.runCommand = (cmd, args) =>
      cmd === "git" && args[0] === "branch" ? { status: 0, stdout: `${b}\n`, stderr: "" } : base(cmd, args);
    const res = await run(["--issue", "OPE-5", "--summary", "s"], deps);
    assert.equal(res.exitCode, 1);
    assert.equal(commands.some((c) => c[0] === "git" && c[1] === "push"), false);
  });
}

// ---- stateful board mock: rerun, work-product shapes, 422 ------------------------------------------
function board({ status = "in_progress", wps = [], wpResponse, patchReject } = {}) {
  const state = { issue: { id: "issue-uuid-5", identifier: "OPE-5", status, executionPolicy: REVIEW_POLICY }, wps: [...wps], posts: [], patches: [], comments: [] };
  const commands = [];
  const deps = {
    env: { PAPERCLIP_API_KEY: "secret", PAPERCLIP_API_URL: "http://paperclip-test:3100" },
    runCommand: (cmd, args) => {
      commands.push([cmd, ...args]);
      if (cmd === "git" && args[0] === "branch") return { status: 0, stdout: "bot/OPE-5\n", stderr: "" };
      if (cmd === "git" && args[0] === "rev-parse") return { status: 0, stdout: "abc123\n", stderr: "" };
      if (cmd === "gh" && args[1] === "view")
        return { status: 0, stdout: JSON.stringify({ number: 77, state: "OPEN", title: "OPE-5: work", url: "https://github.com/itkadr-git/myrmidon/pull/77" }), stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
    fetch: async (url, opts = {}) => {
      const m = opts.method || "GET";
      if (url.endsWith("/api/issues/OPE-5")) return { ok: true, status: 200, json: async () => ({ ...state.issue }) };
      if (url.endsWith("/api/issues/issue-uuid-5/work-products")) {
        if (m === "POST") { state.posts.push(JSON.parse(opts.body)); state.wps.push({ type: "pull_request", metadata: { number: 77 } }); return { ok: true, status: 201, json: async () => ({}) }; }
        if (wpResponse) return wpResponse;
        return { ok: true, status: 200, json: async () => state.wps };
      }
      if (url.endsWith("/api/issues/issue-uuid-5") && m === "PATCH") {
        const body = JSON.parse(opts.body);
        state.patches.push(body);
        if (patchReject) return { ok: false, status: 422, text: async () => patchReject };
        state.issue.status = body.status;
        state.comments.push(body.comment);
        return { ok: true, status: 200, json: async () => ({ ...state.issue }) };
      }
      return { ok: false, status: 404, text: async () => "nf" };
    },
  };
  return { state, commands, deps };
}

test("myr-handoff rerun: first run hands off, second run is a no-op (no POST, no comment, no push, no pr create)", async () => {
  const b = board({});
  const first = await run(["--issue", "OPE-5", "--summary", "s1"], b.deps);
  assert.equal(first.exitCode, 0, first.stderr);
  assert.equal(b.state.posts.length, 1);
  assert.equal(b.state.comments.length, 1);
  assert.equal(b.state.issue.status, "in_review");
  const before = b.commands.length;
  const second = await run(["--issue", "OPE-5", "--summary", "s2"], b.deps);
  assert.equal(second.exitCode, 0, second.stderr);
  assert.match(second.stdout, /already in review/);
  assert.equal(b.state.posts.length, 1);
  assert.equal(b.state.comments.length, 1);
  assert.equal(b.state.patches.length, 1);
  const added = b.commands.slice(before);
  assert.equal(added.some((c) => c[0] === "git" && c[1] === "push"), false);
  assert.equal(added.some((c) => c[0] === "gh" && c[2] === "create"), false);
  assert.equal(added.some((c) => c[0] === "gh" && c[2] === "edit"), false);
});

test("myr-handoff already in_review but PR not bound: continues, binds and PATCHes", async () => {
  const b = board({ status: "in_review" });
  const res = await run(["--issue", "OPE-5", "--summary", "s"], b.deps);
  assert.equal(res.exitCode, 0, res.stderr);
  assert.equal(b.state.posts.length, 1);
});

for (const [name, resp] of [
  ["object instead of array", { ok: true, status: 200, json: async () => ({ items: [] }) }],
  ["null body", { ok: true, status: 200, json: async () => null }],
  ["invalid JSON", { ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); } }],
]) {
  test(`myr-handoff GET work-products ${name}: error, no POST, no PATCH`, async () => {
    const b = board({ wpResponse: resp });
    const res = await run(["--issue", "OPE-5", "--summary", "s"], b.deps);
    assert.equal(res.exitCode, 1);
    assert.match(res.stderr, /work_product_verify/);
    assert.equal(b.state.posts.length, 0);
    assert.equal(b.state.patches.length, 0);
    assert.equal(b.state.issue.status, "in_progress");
  });
}

test("myr-handoff 422 on PATCH: status unchanged on the board, one binding POST at most, next steps in message", async () => {
  const b = board({ patchReject: "invalid_issue_disposition: " + "y".repeat(800) });
  const res = await run(["--issue", "OPE-5", "--summary", "s"], b.deps);
  assert.equal(res.exitCode, 1);
  assert.match(res.stderr, /HTTP 422 invalid_issue_disposition/);
  assert.ok(res.stderr.includes("y".repeat(800)), "body is not truncated mid-way under 1000 chars");
  assert.match(res.stderr, /rerun is safe/);
  assert.equal(b.state.issue.status, "in_progress");
  assert.equal(b.state.comments.length, 0);
  assert.equal(b.state.posts.length, 1);
  // retry after the cause is fixed: PR already bound, so no second POST
  const retry = await run(["--issue", "OPE-5", "--summary", "s"], b.deps);
  assert.equal(retry.exitCode, 1);
  assert.equal(b.state.posts.length, 1, "retry must not duplicate the binding");
});

test("myr-handoff admission errors tell what to do next", async () => {
  const b = board({ status: "done" });
  const res = await run(["--issue", "OPE-5", "--summary", "s"], b.deps);
  assert.equal(res.exitCode, 1);
  assert.match(res.stderr, /issue_admission/);
  assert.match(res.stderr, /rerun is safe/);
  assert.equal(b.commands.length, 0);
});
