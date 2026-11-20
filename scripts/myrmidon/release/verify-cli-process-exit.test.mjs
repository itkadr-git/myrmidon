import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cli = fileURLToPath(new URL("./verify-on-prod.mjs", import.meta.url));
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(homedir(), ".myrmidon-test-scratch");

function runCli(scenario) {
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(path.join(scratch, "verify-cli-"));
  try {
    const preload = path.join(dir, "fetch.mjs");
    writeFileSync(preload, `
const scenario = ${JSON.stringify(scenario)};
globalThis.fetch = async (url) => {
  let body;
  if (url === "https://prod.invalid/api/health") {
    if (scenario === "rejection") throw new Error("synthetic fetch rejection");
    body = { status: "ok", version: scenario === "mismatch" ? "1.6.0" : "1.7.0" };
  } else if (url === "https://board.invalid/api/companies/c1/labels") {
    body = [{ id: "l1", name: "1.7" }];
  } else if (url === "https://board.invalid/api/companies/c1/issues?labelId=l1&limit=100&offset=0&view=compact") {
    body = [{ id: "i1", identifier: "TEST-1", title: "Release", status: scenario === "blocked" ? "blocked" : "done" }];
  } else {
    throw new Error("unexpected URL: " + url);
  }
  return { ok: true, status: 200, json: async () => body };
};
`);
    return spawnSync(process.execPath, ["--import", preload, cli,
      "--version", "1.7.0", "--health-url", "https://prod.invalid/api/health",
      "--api-url", "https://board.invalid", "--company-id", "c1", "--api-key", "synthetic-key"],
    { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("CLI exits 0 for exact health and completed release task", () => {
  const result = runCli("success");
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /Result: PASS/);
});

for (const scenario of ["mismatch", "blocked"]) {
  test(`CLI exits 1 with FAIL for ${scenario}`, () => {
    const result = runCli(scenario);
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Result: FAIL/);
  });
}

test("CLI exits 2 on fetch rejection without reporting PASS", () => {
  const result = runCli("rejection");
  assert.ifError(result.error);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /VERIFY-ON-PROD FAILED: synthetic fetch rejection/);
  assert.doesNotMatch(result.stdout + result.stderr, /PASS/);
});
