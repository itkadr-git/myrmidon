import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { run } from "./fetch-release-verdict.mjs";

test("run replaces signed artifacts with unsigned failures and preserves the last valid bytes on refusal", async () => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || path.join(process.env.HOME, ".cache");
  fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, "verdict-replacement-"));
  try {
    const out = path.join(dir, "verdict.json");
    const confirmed = {
      issueId: "release-issue",
      verdict: "confirmed",
      deployedVersion: "abc123",
      checkedAt: "2026-11-16T00:00:00Z",
      signature: "signed-marker-" + "a".repeat(64),
      candidateIssueIds: ["candidate-a", "candidate-b"],
      members: [{ issueId: "candidate-a", evidence: { checks: ["build", { detail: "nested" }] } }],
      extra: { labels: ["opaque", 42], enabled: true },
    };
    const failed = {
      issueId: "release-issue",
      verdict: "failed",
      deployedVersion: null,
      checkedAt: "2026-11-16T01:00:00Z",
      candidateIssueIds: ["candidate-c"],
      members: [{ issueId: "candidate-c", evidence: { checks: ["missing"] } }],
      extra: { diagnostic: [null, { why: "not deployed" }] },
    };
    const invalid = { ...failed, verdict: "unknown" };
    const originals = [confirmed, failed, invalid].map((value) => structuredClone(value));
    const args = { version: "1.7.0", issue: "release-issue", out, apiKey: "fixture-key" };
    const deps = { env: {}, log: () => {} };
    let calls = 0;
    const invoke = (verdict) => run(args, deps, async (_api, pathname, init) => {
      calls += 1;
      assert.equal(pathname, "/api/issues/release-issue/release-verify");
      assert.equal(init.method, "POST");
      return verdict;
    });
    const bytes = () => fs.readFileSync(out);
    const expected = (verdict) => Buffer.from(`${JSON.stringify(verdict, null, 2)}\n`);

    fs.writeFileSync(out, "old-artifact-tail-".repeat(2048));
    assert.equal(await invoke(confirmed), 0);
    assert.deepEqual(bytes(), expected(originals[0]));
    assert.equal(await invoke(failed), 0);
    assert.deepEqual(bytes(), expected(originals[1]));
    assert.equal(bytes().includes(Buffer.from("signed-marker-")), false);
    assert.equal(bytes().includes(Buffer.from("old-artifact-tail-")), false);
    assert.equal(await invoke(failed), 0);
    const lastValid = bytes();
    assert.deepEqual(lastValid, expected(originals[1]));
    assert.equal(await invoke(invalid), 1);
    assert.deepEqual(bytes(), lastValid);
    assert.deepEqual([confirmed, failed, invalid], originals);
    assert.equal(calls, 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
