import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { main } from "./verify-on-prod.mjs";

const args = ["--version", "1.7.0", "--health-url", "http://prod.test/api/health", "--api-url", "http://board.test", "--company-id", "c1", "--api-key", "synthetic-key"];

async function runMain(argv, status = "done") {
  const originalFetch = globalThis.fetch;
  const originalWrite = process.stdout.write;
  let output = "";
  globalThis.fetch = async (url) => {
    const responses = {
      "http://prod.test/api/health": { status: "ok", version: "1.7.0" },
      "http://board.test/api/companies/c1/labels": [{ id: "l1", name: "1.7" }],
      "http://board.test/api/companies/c1/issues?labelId=l1&limit=100&offset=0&view=compact": [{ id: "i1", identifier: "OPE-1", title: "Release", status }],
    };
    if (!Object.hasOwn(responses, String(url))) throw new Error(`Unexpected URL: ${url}`);
    return { ok: true, json: async () => responses[String(url)] };
  };
  process.stdout.write = (chunk) => { output += chunk; return true; };
  try {
    const code = await main(argv);
    return { code, output };
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalWrite;
  }
}

async function withScratch(fn) {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(os.homedir(), ".myrmidon-test-scratch");
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, "verify-report-"));
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const [status, verified, exitCode] of [["done", true, 0], ["blocked", false, 1]]) {
  test(`--report saves the exact stdout JSON when gate is ${verified ? "passing" : "failing"}`, async () => withScratch(async (dir) => {
    const reportPath = path.join(dir, "report.json");
    const sentinel = path.join(dir, "sentinel.txt");
    fs.writeFileSync(sentinel, "unrelated sentinel\n");
    const before = fs.readFileSync(sentinel);
    const { code, output } = await runMain([...args, "--report", reportPath], status);
    assert.equal(code, exitCode);
    assert.ok(output.endsWith("\n"));
    const report = JSON.parse(output);
    assert.equal(report.verified, verified);
    assert.equal(report.version, "1.7.0");
    assert.equal(typeof report.generatedAt, "string");
    assert.equal(new Date(report.generatedAt).toISOString(), report.generatedAt);
    assert.deepEqual(fs.readFileSync(reportPath), Buffer.from(output, "utf8"));
    assert.deepEqual(fs.readFileSync(sentinel), before);
  }));
}

test("--report rejects a nonexistent parent instead of reporting a successful write", async () => withScratch(async (dir) => {
  const reportPath = path.join(dir, "missing", "report.json");
  await assert.rejects(runMain([...args, "--report", reportPath]), { code: "ENOENT" });
  assert.equal(fs.existsSync(reportPath), false);
}));

test("without --report main prints text and creates no report file", async () => withScratch(async (dir) => {
  const before = fs.readdirSync(dir);
  const originalCwd = process.cwd();
  try {
    process.chdir(dir);
    const { code, output } = await runMain(args);
    assert.equal(code, 0);
    assert.match(output, /^# VERIFY-ON-PROD 1\.7\.0\n/);
    assert.match(output, /Result: PASS/);
    assert.throws(() => JSON.parse(output), SyntaxError);
    assert.deepEqual(fs.readdirSync(dir), before);
  } finally {
    process.chdir(originalCwd);
  }
}));
