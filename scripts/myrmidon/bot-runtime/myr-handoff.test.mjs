import test from "node:test";
import assert from "node:assert/strict";
import { run, resolveReviewerAgentId } from "../../../docker/bot-runtime/myr-ws/lib/handoff.js";

test("resolveReviewerAgentId resolves mod 6 mapping", () => {
  assert.equal(resolveReviewerAgentId(0), "dbd3f01c-518e-4c1d-a05a-2a4bf25acf93"); // adm-dev-review-8
  assert.equal(resolveReviewerAgentId(1), "d674a53a-3abd-43fe-8f49-696a04937323"); // adm-dev-review-9
  assert.equal(resolveReviewerAgentId(2), "07555686-c5f7-4536-ac2b-c9ab1027e89f"); // adm-dev-review-10
  assert.equal(resolveReviewerAgentId(3), "62640ae6-658b-4cde-ba3a-b6a88e708df9"); // adm-dev-review-11
  assert.equal(resolveReviewerAgentId(4), "b7040a16-03a0-4d3c-8060-709038ccc403"); // adm-dev-review-12
  assert.equal(resolveReviewerAgentId(5), "c85f5dac-4a13-4bdb-9498-c666fe45d4c9"); // adm-dev-review-13
  assert.equal(resolveReviewerAgentId(6), "dbd3f01c-518e-4c1d-a05a-2a4bf25acf93"); // adm-dev-review-8
});

test("myr-handoff requires --issue and --summary", async () => {
  const res = await run([]);
  assert.equal(res.exitCode, 1);
  assert.match(res.stderr, /--issue and --summary are required/);
});

test("myr-handoff fails if git branch cannot be determined", async () => {
  const deps = {
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
  // 42 % 6 = 0 -> adm-dev-review-8
  assert.equal(patchedPayload.executionPolicy.stages[0].participants[0].agentId, "dbd3f01c-518e-4c1d-a05a-2a4bf25acf93");
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
          stdout: JSON.stringify({ number: 43, title: "some work", url: "https://github.com/itkadr-git/myrmidon/pull/43" }),
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
          json: async () => [],
        };
      }
      return { ok: false, status: 404, text: async () => "not found" };
    },
  };

  const res = await run(["--issue", "OPE-999", "--summary", "second run"], deps);
  assert.equal(res.exitCode, 0);
  assert.equal(res.stdout, "PR #43 sha feedbeef999 status in_review bound pending_sync\n");
  const editCmd = commandsRun.find((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "edit");
  assert.ok(editCmd);
  assert.equal(editCmd[4], "--title");
  assert.equal(editCmd[5], "OPE-999: some work");
});
