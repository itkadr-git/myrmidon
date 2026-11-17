import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { run } from "./fetch-release-verdict.mjs";

const issue = "release / issue?#";
const env = {
  PAPERCLIP_API_URL: "https://alpha.example.invalid///",
  PAPERCLIP_API_KEY: "fixture-key-alpha",
  PAPERCLIP_COMPANY_ID: "company-alpha",
};
const originalEnv = { ...env };
const defaults = { apiUrl: "https://alpha.example.invalid", apiKey: "fixture-key-alpha", companyId: "company-alpha" };
const overrides = { apiUrl: "https://beta.example.invalid///", apiKey: "fixture-key-beta", companyId: "company-beta" };
const verdict = {
  issueId: issue,
  verdict: "confirmed",
  deployedVersion: "synthetic-version",
  checkedAt: "2026-11-17T00:00:00.000Z",
};
verdict.signature = createHmac("sha256", "fixture-signing-key")
  .update(`${verdict.verdict}|${verdict.deployedVersion}|${verdict.checkedAt}|${verdict.issueId}`)
  .digest("hex");

test("run applies full and independent API overrides without leaking into the next call", async () => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || os.homedir();
  assert.ok(scratch && path.isAbsolute(scratch), "a run scratch directory is required");
  const dir = fs.mkdtempSync(path.join(scratch, "fetch-api-overrides-"));
  const calls = [];
  const fetchBoard = async (api, pathname, init) => {
    calls.push({ api: { ...api }, pathname, init });
    return verdict;
  };
  const cases = [
    { args: overrides, expected: { apiUrl: "https://beta.example.invalid", apiKey: "fixture-key-beta", companyId: "company-beta" } },
    { args: {}, expected: defaults },
    { args: { apiUrl: overrides.apiUrl }, expected: { ...defaults, apiUrl: "https://beta.example.invalid" } },
    { args: { apiKey: overrides.apiKey }, expected: { ...defaults, apiKey: "fixture-key-beta" } },
    { args: { companyId: overrides.companyId }, expected: { ...defaults, companyId: "company-beta" } },
  ];
  try {
    for (const [index, scenario] of cases.entries()) {
      const out = path.join(dir, `verdict-${index}.json`);
      const code = await run({ version: "1.8.0", issue, out, ...scenario.args }, { env, log: () => {} }, fetchBoard);
      assert.equal(code, 0, `case ${index}`);
      assert.deepEqual(calls[index], {
        api: scenario.expected,
        pathname: "/api/issues/release%20%2F%20issue%3F%23/release-verify",
        init: { method: "POST", body: "{}" },
      }, `case ${index}`);
      assert.equal(calls.length, index + 1);
      assert.equal(fs.readFileSync(out, "utf8"), `${JSON.stringify(verdict, null, 2)}\n`);
      assert.deepEqual(env, originalEnv);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
