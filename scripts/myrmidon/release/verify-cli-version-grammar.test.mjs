import assert from "node:assert/strict";
import { test } from "node:test";
import { main } from "./verify-on-prod.mjs";

const healthUrl = "http://production.invalid/api/health";
const apiUrl = "http://board.invalid";
const labelsUrl = `${apiUrl}/api/companies/company/labels`;
const issuesUrl = `${apiUrl}/api/companies/company/issues?labelId=release&limit=100&offset=0&view=compact`;

function args(version) {
  return ["--version", version, "--health-url", healthUrl, "--api-url", apiUrl,
    "--company-id", "company", "--label", "release", "--api-key", "synthetic-key"];
}

async function runWithFakeFetch(version, check) {
  const originalFetch = globalThis.fetch;
  const originalWrite = process.stdout.write;
  const calls = [];
  let output = "";
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    let data;
    if (url === healthUrl) data = { status: "ok", version };
    else if (url === labelsUrl) data = [{ id: "release", name: "release" }];
    else if (url === issuesUrl) data = [{ id: "issue", identifier: "TEST-1", title: "Release", status: "done" }];
    else throw new Error(`unexpected URL: ${url}`);
    return { ok: true, status: 200, json: async () => data };
  };
  process.stdout.write = (chunk) => { output += chunk; return true; };
  try {
    await check({ calls, output: () => output });
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalWrite;
  }
}

for (const version of ["1.7", "v1.7.0", "1.7.0-rc.1", "1.7.0+meta", " 1.7.0", "1.7.0 ", "1.7.0\n", "-1.7.0", "1.-7.0", "1.7.-0", "1.7.0.5"]) {
  test(`rejects invalid version ${JSON.stringify(version)} before fetch`, async () => {
    await runWithFakeFetch(version, async ({ calls }) => {
      await assert.rejects(main(args(version)), /--version must look like X\.Y\.Z/);
      assert.deepEqual(calls, []);
    });
  });
}

for (const version of ["1.7.0", "12.34.56", "01.007.000"]) {
  test(`accepts ${version} and verifies health and release tasks`, async () => {
    await runWithFakeFetch(version, async ({ calls, output }) => {
      assert.equal(await main(args(version)), 0);
      assert.deepEqual(calls, [healthUrl, labelsUrl, issuesUrl]);
      assert.match(output(), /Result: PASS/);
      assert.match(output(), /PASS TEST-1/);
    });
  });
}
