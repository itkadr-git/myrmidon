import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { main, EXIT_OK } from "./verify-on-prod.mjs";

const healthUrl = "http://health.invalid/api/health";
const boardUrl = "http://board.invalid";
const args = ["--version", "1.7.0", "--health-url", healthUrl, "--api-url", boardUrl, "--company-id", "c1"];

async function withHarness(run) {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(os.homedir(), ".myrmidon-test-scratch");
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, "verify-token-"));
  const originalFetch = globalThis.fetch;
  const originalWrite = process.stdout.write;
  const originalKey = process.env.PAPERCLIP_API_KEY;
  const calls = [];
  let output = "";
  try {
    delete process.env.PAPERCLIP_API_KEY;
    process.stdout.write = (chunk) => { output += chunk; return true; };
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      let data;
      if (url === healthUrl) data = { status: "ok", version: "1.7.0" };
      else if (url === `${boardUrl}/api/companies/c1/labels`) data = [{ id: "l1", name: "1.7" }];
      else if (url === `${boardUrl}/api/companies/c1/issues?labelId=l1&limit=100&offset=0&view=compact`) data = [{ id: "i1", status: "done" }];
      else throw new Error(`unexpected URL: ${url}`);
      return { ok: true, json: async () => data };
    };
    await run({ dir, calls, output: () => output });
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalWrite;
    if (originalKey === undefined) delete process.env.PAPERCLIP_API_KEY;
    else process.env.PAPERCLIP_API_KEY = originalKey;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("main reads and trims the health token file before fetching health", async () => {
  await withHarness(async ({ dir, calls }) => {
    const token = "synthetic-health-token";
    const tokenFile = path.join(dir, "token");
    fs.writeFileSync(tokenFile, ` \r\n${token}\r\n  `);
    assert.equal(await main([...args, "--health-token-file", tokenFile]), EXIT_OK);
    assert.equal(calls[0].url, healthUrl);
    assert.equal(calls[0].init.headers.Authorization === `Bearer ${token}`, true, "health authorization must contain the trimmed file contents");
  });
});

test("main sends no health token when the file argument is absent", async () => {
  await withHarness(async ({ calls }) => {
    assert.equal(await main(args), EXIT_OK);
    assert.equal(calls[0].url, healthUrl);
    assert.equal(Object.hasOwn(calls[0].init.headers, "Authorization"), false);
  });
});

test("main rejects a missing token file before fetch or output", async () => {
  await withHarness(async ({ dir, calls, output }) => {
    const report = path.join(dir, "report.json");
    await assert.rejects(main([...args, "--health-token-file", path.join(dir, "missing"), "--report", report]), { code: "ENOENT" });
    assert.equal(calls.length, 0);
    assert.equal(output(), "");
    assert.equal(fs.existsSync(report), false);
  });
});
