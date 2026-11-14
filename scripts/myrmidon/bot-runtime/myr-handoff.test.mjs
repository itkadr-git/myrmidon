import test from "node:test";
import assert from "node:assert/strict";
import { run } from "../../../docker/bot-runtime/myr-ws/lib/handoff.js";

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

test("myr-handoff fails if PR binding fails when work product cannot be created", async () => {
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
        return { ok: true, json: async () => ({ id: "issue-uuid-55", identifier: "OPE-55", executionPolicy: REVIEW_POLICY }) };
      }
      if (url.endsWith("/api/issues/issue-uuid-55") && opts.method === "PATCH") {
        return { ok: true, json: async () => ({ id: "issue-uuid-55", status: "in_review" }) };
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
  assert.ok(res.stderr.length < 500);
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

test("myr-handoff without review stage and with --reviewer adds the stage and keeps policy fields", async () => {
  const sink = { patches: [], commands: [] };
  const policy = {
    mode: "normal",
    monitor: { intervalMinutes: 30 },
    stages: [{ id: "st-a", type: "approval", approvalsNeeded: 1, participants: [{ type: "user", userId: "u1" }] }],
  };
  const res = await run(["--issue", "OPE-5", "--summary", "s", "--reviewer", "agent-r1"], policyDeps(policy, sink));
  assert.equal(res.exitCode, 0);
  const ep = sink.patches[0].executionPolicy;
  assert.deepEqual(ep.monitor, { intervalMinutes: 30 });
  assert.equal(ep.mode, "normal");
  assert.equal(ep.stages.length, 2);
  assert.deepEqual(ep.stages[0], policy.stages[0]);
  assert.equal(ep.stages[1].type, "review");
  assert.equal(ep.stages[1].approvalsNeeded, 1);
  assert.deepEqual(ep.stages[1].participants, [{ type: "agent", agentId: "agent-r1" }]);
});

test("myr-handoff without review stage and without --reviewer fails and sends no PATCH", async () => {
  const sink = { patches: [], commands: [] };
  const res = await run(["--issue", "OPE-5", "--summary", "s"], policyDeps(null, sink));
  assert.notEqual(res.exitCode, 0);
  assert.match(res.stderr, /issue has no review stage: pass --reviewer <agentId> \(see your instructions\)/);
  assert.equal(sink.patches.length, 0);
  assert.equal(sink.commands.some((c) => c[0] === "git" && c[1] === "push"), false);
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

  // Case 3: Server PATCH rejects admission with 422 invalid_issue_disposition -> status remains in_progress
  issueRecord.reviewPolicy = "standard";
  const commandsLate = [];
  const depsLate = makeDeps({
    commandsRun: commandsLate,
    patchStatus: 422,
  });
  // patchStatus: 422 returns { ok: false, status: 422, text: () => "invalid_issue_disposition: missing green CI" }
  const resLate = await run(["--issue", "OPE-5", "--summary", "try handoff"], depsLate);
  assert.equal(resLate.exitCode, 1);
  assert.match(resLate.stderr, /failed at step issue_patch/);
  assert.match(resLate.stderr, /HTTP 422/);
  assert.match(resLate.stderr, /PR #77 sha abc123/);
});
