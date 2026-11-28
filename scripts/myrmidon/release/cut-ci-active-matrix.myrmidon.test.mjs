import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ciStatusForCommit } from "./cut-rc.mjs";

const sha = "1".repeat(40);
const completed = (id, workflowName) => ({
  databaseId: id, headSha: sha, status: "completed", conclusion: "success", workflowName, event: "push",
});

function checkRuns(runs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cut-ci-matrix-"));
  try {
    const log = path.join(dir, "calls");
    const payload = path.join(dir, "runs.json");
    fs.writeFileSync(payload, JSON.stringify(runs));
    fs.writeFileSync(path.join(dir, "gh"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALL_LOG"\nif [ "$1" = "--version" ]; then printf "gh 2.0\\n"; exit 0; fi\nif [ "$1" = "run" ] && [ "$2" = "list" ]; then /bin/cat "$RUNS_FILE"; exit 0; fi\nexit 1\n', { mode: 0o755 });
    const result = ciStatusForCommit(null, {
      repo: "itkadr-git/myrmidon", branch: "main", sha,
      env: { PATH: dir, CALL_LOG: log, RUNS_FILE: payload },
    });
    const calls = fs.readFileSync(log, "utf8").trim().split("\n");
    assert.equal(calls.length, 2);
    assert.equal(calls[0], "--version");
    assert.match(calls[1], /^run list --branch main --limit 30 --repo itkadr-git\/myrmidon --json /);
    return result;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("active workflows block a successful neighbor in either order", () => {
  for (const status of ["queued", "in_progress", "waiting", "pending"]) {
    const active = { ...completed(2, `Active ${status}`), status };
    const green = completed(1, "Green CI");
    for (const runs of [[green, active], [active, green]]) {
      assert.deepEqual(checkRuns(runs), {
        ok: false,
        reason: `CI still running for ${sha}: Active ${status}`,
      }, `${status}, active index ${runs.indexOf(active)}`);
    }
  }
});

test("two completed successful workflows are green in either order", () => {
  const first = completed(1, "First CI");
  const second = completed(2, "Second CI");
  for (const runs of [[first, second], [second, first]]) {
    assert.deepEqual(checkRuns(runs), { ok: true });
  }
});
