import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseArgs, run } from "./fetch-release-verdict.mjs";

const issue = "release /?# \u96ea";
const pathname = "/api/issues/release%20%2F%3F%23%20%E9%9B%AA/release-verify";
const verdict = {
  issueId: issue,
  verdict: "confirmed",
  checkedAt: "2026-11-16T00:00:00.000Z",
  deployedVersion: "abc123",
  signature: "synthetic-signature",
};
const deps = {
  env: { PAPERCLIP_API_URL: "http://board.invalid", PAPERCLIP_API_KEY: "fixture-key", PAPERCLIP_COMPANY_ID: "fixture-company" },
  log: () => {},
};

async function withOutput(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verdict-request-"));
  try {
    await fn(path.join(dir, "verdict.json"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function argumentsFor(out) {
  return parseArgs(["--version", "1.7.0", "--board-label", "unused-label", "--issue", issue, "--out", out]);
}

test("explicit issue sends exactly one encoded POST and writes the verdict", async () => {
  await withOutput(async (out) => {
    const args = argumentsFor(out);
    const before = structuredClone(args);
    const calls = [];
    const code = await run(args, deps, async (_api, requestPath, init) => {
      calls.push({ pathname: requestPath, init });
      return verdict;
    });
    assert.equal(code, 0);
    assert.deepEqual(calls, [{ pathname, init: { method: "POST", body: "{}" } }]);
    assert.deepEqual(JSON.parse(fs.readFileSync(out, "utf8")), verdict);
    assert.deepEqual(args, before);
  });
});

test("transport exception makes one POST, returns failure, and preserves the artifact", async () => {
  await withOutput(async (out) => {
    const previous = "previous artifact\n";
    fs.writeFileSync(out, previous);
    const args = argumentsFor(out);
    const before = structuredClone(args);
    const calls = [];
    const code = await run(args, deps, async (_api, requestPath, init) => {
      calls.push({ pathname: requestPath, init });
      throw new Error("fixture transport failure");
    });
    assert.equal(code, 1);
    assert.deepEqual(calls, [{ pathname, init: { method: "POST", body: "{}" } }]);
    assert.equal(fs.readFileSync(out, "utf8"), previous);
    assert.deepEqual(args, before);
  });
});
