import test from "node:test";
import assert from "node:assert/strict";
import { run } from "../../../docker/bot-runtime/myr-ws/lib/handoff.js";

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
      json: async () => ({ id: "issue-uuid-123", identifier: "OPE-123" }),
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
      json: async () => ({ id: "issue-uuid-123", identifier: "OPE-123" }),
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
          json: async () => ({ id: "issue-uuid-123", identifier: "OPE-123" }),
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
          json: async () => ({ id: "issue-uuid-999", identifier: "OPE-999" }),
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
      json: async () => ({ id: "issue-uuid-123", identifier: "OPE-123" }),
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
        return { ok: true, json: async () => ({ id: "issue-uuid-55", identifier: "OPE-55" }) };
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
        return { ok: true, status: 200, json: async () => ({ id: "issue-uuid-5", identifier: "OPE-5" }) };
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
