import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { run } from "./docs-reminder.mjs";

const api = "https://api.example.invalid";
const repo = "example/project";
const prNumber = 42;
const token = "synthetic-token";
const marker = "<!-- docs-reminder -->";
const body = [
  marker,
  "This PR changes the API/schema/generated capability surface, but the diff",
  "has no file under `docs/myrmidon/changes/` and none under",
  "`skills/myrmidon/references/`. Please check whether both need the same",
  "change (agents read the docs and the skill; ignore this comment if not).",
  "",
  "Changed surface files:",
  "- `server/example-schema.ts`",
  "",
  "How to ship the docs entry: add `docs/myrmidon/changes/<branch-slug>.md`",
  "(one file per PR; format and a copy-paste template:",
  "docs/myrmidon/changes/README.md). The release cut folds fragments into the",
  "shared registry documents — they are never edited by hand in a PR. If the",
  "change affects how agents do their work, also update the matching file in",
  "`skills/myrmidon/references/`.",
  "",
  "This reminder is informational only and never fails CI.",
].join("\n");
const args = [api, repo, prNumber, token];

async function sandbox(fn) {
  const parent = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(process.env.HOME, "cache/scratch");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "docs-boundary-"));
  const git = (...argv) => execFileSync("git", argv, { cwd: root, encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    git("config", "user.name", "Test User");
    git("config", "user.email", "test@example.invalid");
    git("commit", "--allow-empty", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    fs.mkdirSync(path.join(root, "server"));
    fs.writeFileSync(path.join(root, "server/example-schema.ts"), "export const example = 1;\n");
    git("add", ".");
    git("commit", "-qm", "trigger");
    const head = git("rev-parse", "HEAD");
    await fn({ root, base, head, api, repo, prNumber, token });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function callbacks(comments, created = { id: 17 }) {
  const calls = { list: [], post: [] };
  return {
    calls,
    list: async (...values) => { calls.list.push(values); return comments; },
    post: async (...values) => { calls.post.push(values); return created; },
  };
}

test("missing input skips before git or API access", async () => {
  for (const key of ["token", "prNumber", "base", "head", "repo"]) {
    const fake = callbacks([]);
    const result = await run({ root: "/nonexistent/docs-reminder-test", token, prNumber, base: "base", head: "head", repo, api, ...fake, [key]: undefined });
    assert.deepEqual(result, { status: "skipped", reason: "missing token/PR data (fork or workflow_dispatch) — silent exit" }, key);
    assert.deepEqual(fake.calls, { list: [], post: [] }, key);
  }
});

test("only exact bot identity and string marker suppress posting", async () => {
  await sandbox(async (input) => {
    const cases = [
      { name: "bot marker without id", comment: { body: marker, user: { login: "github-actions[bot]" } }, suppressed: true },
      { name: "human marker", comment: { body: marker, user: { login: "human" } } },
      { name: "similar bot marker", comment: { body: marker, user: { login: "github-actions[bot]-other" } } },
      { name: "bot without marker", comment: { body: "hello", user: { login: "github-actions[bot]" } } },
      { name: "null body", comment: { body: null, user: { login: "github-actions[bot]" } } },
      { name: "nonstring body", comment: { body: 42, user: { login: "github-actions[bot]" } } },
      { name: "missing user", comment: { body: marker } },
      { name: "no comments", comment: null },
    ];
    for (const item of cases) {
      const fake = callbacks(item.comment ? [item.comment] : []);
      const result = await run({ ...input, ...fake });
      assert.deepEqual(fake.calls.list, [args], item.name);
      if (item.suppressed) {
        assert.deepEqual(result, { status: "already-posted", commentId: undefined }, item.name);
        assert.deepEqual(fake.calls.post, [], item.name);
      } else {
        assert.deepEqual(result, { status: "posted", commentId: 17 }, item.name);
        assert.deepEqual(fake.calls.post, [[...args, body]], item.name);
      }
    }
  });
});

test("list rejection propagates unchanged and a later call recovers", async () => {
  await sandbox(async (input) => {
    const error = new Error("synthetic list failure");
    const fake = callbacks([]);
    const list = async (...values) => { fake.calls.list.push(values); throw error; };
    await assert.rejects(run({ ...input, ...fake, list }), (actual) => actual === error);
    assert.deepEqual(fake.calls, { list: [args], post: [] });
    const retry = callbacks([]);
    assert.deepEqual(await run({ ...input, ...retry }), { status: "posted", commentId: 17 });
    assert.deepEqual(retry.calls, { list: [args], post: [[...args, body]] });
  });
});

test("post rejection propagates unchanged and a later call recovers without an id", async () => {
  await sandbox(async (input) => {
    const error = new Error("synthetic post failure");
    const fake = callbacks([]);
    const post = async (...values) => { fake.calls.post.push(values); throw error; };
    await assert.rejects(run({ ...input, ...fake, post }), (actual) => actual === error);
    assert.deepEqual(fake.calls, { list: [args], post: [[...args, body]] });
    const retry = callbacks([], {});
    assert.deepEqual(await run({ ...input, ...retry }), { status: "posted", commentId: null });
    assert.deepEqual(retry.calls, { list: [args], post: [[...args, body]] });
  });
});
