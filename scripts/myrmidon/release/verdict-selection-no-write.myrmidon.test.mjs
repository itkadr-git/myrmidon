import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { run } from "./fetch-release-verdict.mjs";

const env = {
  PAPERCLIP_API_URL: "http://board.invalid",
  PAPERCLIP_API_KEY: "test-only",
  PAPERCLIP_COMPANY_ID: "company-test",
};
const labelPath = "/api/companies/company-test/labels";
const issuePath = "/api/companies/company-test/issues?labelId=label-17&limit=100&offset=0&view=compact";
const first = { id: "issue-a", identifier: "TEST-1" };
const second = { id: "issue-b", identifier: "TEST-2" };
const sentinel = Buffer.from("existing artifact\n\u0000unchanged", "utf8");

async function scenario({ issues = [], error = null, explicit = null }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verdict-selection-"));
  try {
    const out = path.join(dir, "verdict.json");
    fs.writeFileSync(out, sentinel);
    const calls = [];
    const logs = [];
    const verdict = {
      issueId: explicit || first.id,
      releaseLabel: "1.7",
      candidateIssueIds: ["candidate-1"],
      deployedVersion: "0123456789012345678901234567890123456789",
      verdict: "confirmed",
      failureReason: null,
      reason: "all members present",
      checkedAt: "2026-11-16T00:00:00.000Z",
      members: [],
      signature: "a".repeat(64),
    };
    const code = await run(
      { version: "1.7.0", issue: explicit, out },
      { env, log: (message) => logs.push(message) },
      async (_api, pathname, init) => {
        calls.push({ pathname, method: init?.method || "GET", body: init?.body });
        if (pathname === labelPath) {
          if (error) throw new Error(error);
          return [{ id: "label-17", name: "1.7" }];
        }
        if (pathname === issuePath) return issues;
        if (pathname === `/api/issues/${encodeURIComponent(verdict.issueId)}/release-verify`) return verdict;
        throw new Error(`unexpected route: ${pathname}`);
      },
    );
    return { code, calls, logs, bytes: fs.readFileSync(out), verdict };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const [name, options, message, expectedPaths] of [
  ["no matching issues", { issues: [] }, /no issue carries/, [labelPath, issuePath]],
  ["two matching issues", { issues: [first, second] }, /disambiguate/, [labelPath, issuePath]],
  ["label lookup failure", { error: "label lookup unavailable" }, /label lookup unavailable/, [labelPath]],
]) {
  test(`selection refuses ${name} without changing the artifact or posting`, async () => {
    const result = await scenario(options);
    assert.equal(result.code, 1);
    assert.match(result.logs.join("\n"), message);
    assert.deepEqual(result.calls.map(({ pathname }) => pathname), expectedPaths);
    assert.ok(result.calls.every(({ method }) => method === "GET"));
    assert.deepEqual(result.bytes, sentinel);
  });
}

test("one matching issue posts once to its id and writes the verdict", async () => {
  const result = await scenario({ issues: [first] });
  assert.equal(result.code, 0);
  assert.deepEqual(result.calls, [
    { pathname: labelPath, method: "GET", body: undefined },
    { pathname: issuePath, method: "GET", body: undefined },
    { pathname: "/api/issues/issue-a/release-verify", method: "POST", body: "{}" },
  ]);
  assert.deepEqual(JSON.parse(result.bytes.toString("utf8")), result.verdict);
  assert.equal(result.verdict.checkedAt, "2026-11-16T00:00:00.000Z");
});

test("explicit issue bypasses lookup and posts once to the explicit id", async () => {
  const result = await scenario({ explicit: "explicit/id" });
  assert.equal(result.code, 0);
  assert.deepEqual(result.calls, [
    { pathname: "/api/issues/explicit%2Fid/release-verify", method: "POST", body: "{}" },
  ]);
  assert.deepEqual(JSON.parse(result.bytes.toString("utf8")), result.verdict);
});
