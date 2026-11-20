import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const workflow = fs.readFileSync(path.join(root, ".github/workflows/myrmidon-ci-tag.yml"), "utf8");
const match = workflow.match(/      - name: Verify release build queue priority\n[\s\S]*?        run: \|\n([\s\S]*?)(?=\n      - name:)/);
assert.ok(match, "queue step exists");
const script = match[1].split("\n").map((line) => line.replace(/^ {10}/, "")).join("\n");

function runStep(runs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tag-queue-test-"));
  try {
    fs.writeFileSync(path.join(dir, "runs.json"), JSON.stringify(runs));
    fs.copyFileSync(path.join(root, "scripts/myrmidon/release/release-jobs.mjs"), path.join(dir, "release-jobs.mjs"));
    fs.writeFileSync(path.join(dir, "gh"), `#!/usr/bin/env node
const runs = require(process.env.FIXTURE);
const url = new URL('https://example.test/' + process.argv[3]);
const status = url.searchParams.get('status');
const filtered = status ? runs.filter(r => r.status === status) : runs;
const page = Number(url.searchParams.get('page') || 1);
console.log(JSON.stringify({total_count: filtered.length, workflow_runs: filtered.slice((page-1)*100,page*100)}));
`, { mode: 0o755 });
    return spawnSync("bash", ["-c", script], { cwd: root, encoding: "utf8", env: {
      ...process.env, BASH_ENV: "", PATH: `${dir}:${process.env.PATH}`, FIXTURE: path.join(dir, "runs.json"),
      RUNNER_TEMP: dir, REPO: "example/repo", WORKFLOW: "Myrmidon CI (tag)", PRIORITY_POOL: '["priority"]',
    } });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test("queue step ignores historical runs and executes its empty-set branch", () => {
  const result = runStep(Array.from({ length: 350 }, () => ({ status: "completed" })));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no pending runs/);
});

test("queue step evaluates a non-empty competing set", () => {
  const result = runStep([{ status: "queued", name: "Myrmidon CI (tag)", head_branch: "myr-v1.2.3", created_at: "2026-01-01T00:00:00Z" }]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no factual dispatch inversion/);
});

test("queue step refuses a truncated pending set", () => {
  const result = runStep(Array.from({ length: 301 }, () => ({ status: "queued", name: "Myrmidon CI" })));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /truncated/);
});
