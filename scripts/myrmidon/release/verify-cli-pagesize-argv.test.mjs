import assert from "node:assert/strict";
import { test } from "node:test";
import { main } from "./verify-on-prod.mjs";

const baseArgs = [
  "--version", "1.7.0", "--health-url", "https://health.test/api/health",
  "--api-url", "https://board.test", "--company-id", "c1", "--api-key", "synthetic-key",
];

async function runCli(extraArgs, issues) {
  const originalFetch = globalThis.fetch;
  const originalWrite = process.stdout.write;
  const calls = [];
  let output = "";
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    calls.push(url.href);
    let body;
    if (url.href === "https://health.test/api/health") {
      body = { status: "ok", version: "1.7.0" };
    } else if (url.href === "https://board.test/api/companies/c1/labels") {
      body = [{ id: "l1", name: "1.7" }];
    } else if (url.origin === "https://board.test" && url.pathname === "/api/companies/c1/issues" &&
      url.searchParams.get("labelId") === "l1" && url.searchParams.get("view") === "compact" &&
      [...url.searchParams.keys()].sort().join(",") === "labelId,limit,offset,view") {
      const limit = Number(url.searchParams.get("limit"));
      const offset = Number(url.searchParams.get("offset"));
      assert.ok(Number.isSafeInteger(limit) && limit > 0);
      assert.ok(Number.isSafeInteger(offset) && offset >= 0);
      body = issues.slice(offset, offset + limit);
    } else {
      throw new Error(`unexpected URL: ${url.href}`);
    }
    return { ok: true, json: async () => body };
  };
  process.stdout.write = (chunk) => { output += chunk; return true; };
  try {
    const result = await main([...baseArgs, ...extraArgs]);
    return { result, calls, output };
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalWrite;
  }
}

const issues = Array.from({ length: 4 }, (_, i) => ({
  id: `id-${i}`, identifier: `TEST-${i}`, title: `Task ${i}`, status: "done",
}));

test("CLI rejects invalid page-size arguments before any fetch", async () => {
  for (const value of [null, "0", "-1", "1.5", "NaN", "Infinity", "1e2", "9007199254740992"]) {
    let fetches = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { fetches++; throw new Error("unexpected fetch"); };
    try {
      const pageArg = value === null ? ["--page-size"] : ["--page-size", value];
      await assert.rejects(main([...baseArgs, ...pageArg]), /--page-size must be a positive safe integer/, String(value));
      assert.equal(fetches, 0, String(value));
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
});

test("CLI defaults page-size to 100", async () => {
  const { result, calls, output } = await runCli([], issues);
  assert.equal(result, 0);
  assert.match(output, /Result: PASS/);
  const issueCalls = calls.filter((url) => new URL(url).pathname.endsWith("/issues"));
  assert.equal(issueCalls.length, 1);
  const query = new URL(issueCalls[0]).searchParams;
  assert.equal(query.get("limit"), "100");
  assert.equal(query.get("offset"), "0");
});

test("CLI page-size 2 fetches two full pages and an empty page", async () => {
  const { result, calls, output } = await runCli(["--page-size", "2"], issues);
  assert.equal(result, 0);
  assert.match(output, /Result: PASS/);
  const queries = calls.filter((url) => new URL(url).pathname.endsWith("/issues"))
    .map((url) => new URL(url).searchParams);
  assert.deepEqual(queries.map((query) => query.get("limit")), ["2", "2", "2"]);
  assert.deepEqual(queries.map((query) => query.get("offset")), ["0", "2", "4"]);
});
