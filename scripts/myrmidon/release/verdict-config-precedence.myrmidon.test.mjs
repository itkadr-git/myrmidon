import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, run } from "./fetch-release-verdict.mjs";

const issue = "release-issue";
const envApi = { apiUrl: "https://env.example", apiKey: "env-fixture-secret", companyId: "env-company" };
const cliApi = { apiUrl: "https://cli.example", apiKey: "cli-fixture-secret", companyId: "cli-company" };
const verdict = { issueId: issue, verdict: "confirmed", deployedVersion: null, checkedAt: "fixture-time" };

const cases = [
  ["URL", ["--api-url", "https://cli.example///"], { ...envApi, apiUrl: cliApi.apiUrl }],
  ["key", ["--api-key", cliApi.apiKey], { ...envApi, apiKey: cliApi.apiKey }],
  ["company", ["--company-id", cliApi.companyId], { ...envApi, companyId: cliApi.companyId }],
  ["combined", ["--api-url", "https://cli.example///", "--api-key", cliApi.apiKey, "--company-id", cliApi.companyId], cliApi],
];

for (const [name, flags, expected] of cases) {
  test(`run: ${name} override takes precedence without affecting the next run`, async () => {
    const env = { PAPERCLIP_API_URL: "https://env.example///", PAPERCLIP_API_KEY: envApi.apiKey, PAPERCLIP_COMPANY_ID: envApi.companyId };
    const args = parseArgs(["--version", "1.7.0", "--issue", issue, ...flags]);
    const nextArgs = parseArgs(["--version", "1.7.0", "--issue", issue]);
    const originalEnv = structuredClone(env);
    const originalArgs = structuredClone(args);
    const originalNextArgs = structuredClone(nextArgs);
    const expectedApis = [expected, envApi];
    let calls = 0;
    let apiMatches = true;
    const fetchBoard = async (api, pathname, init) => {
      const wanted = expectedApis[calls++];
      apiMatches &&= !!wanted && api.apiUrl === wanted.apiUrl && api.apiKey === wanted.apiKey && api.companyId === wanted.companyId;
      assert.equal(pathname, `/api/issues/${issue}/release-verify`);
      assert.equal(init.method, "POST");
      return verdict;
    };
    const stdout = mock.method(process.stdout, "write", () => true);
    try {
      assert.equal(await run(args, { env, log: () => {} }, fetchBoard), 0);
      assert.equal(await run(nextArgs, { env, log: () => {} }, fetchBoard), 0);
    } finally {
      stdout.mock.restore();
    }
    assert.equal(calls, 2);
    assert.ok(apiMatches, "fetchBoard received incorrect API configuration");
    assert.deepEqual(env, originalEnv);
    assert.deepEqual(args, originalArgs);
    assert.deepEqual(nextArgs, originalNextArgs);
  });
}

test("run: missing key refuses before calling fetchBoard", async () => {
  const env = { PAPERCLIP_API_URL: "https://env.example///", PAPERCLIP_COMPANY_ID: envApi.companyId };
  const args = parseArgs(["--version", "1.7.0", "--issue", issue]);
  const originalEnv = structuredClone(env);
  const originalArgs = structuredClone(args);
  let calls = 0;
  const code = await run(args, { env, log: () => {} }, async () => { calls++; return verdict; });
  assert.equal(code, 1);
  assert.equal(calls, 0);
  assert.deepEqual(env, originalEnv);
  assert.deepEqual(args, originalArgs);
});
