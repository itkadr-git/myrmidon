import assert from "node:assert/strict";
import { test } from "node:test";
import { main, EXIT_OK } from "./verify-on-prod.mjs";

const baseArgs = [
  "--version", "1.7.0",
  "--health-url", "https://health.test/api/health",
  "--api-url", "https://board.test",
  "--company-id", "company",
];

async function checkKey({ envKey, keyArgs = [], expected }) {
  const originalKey = process.env.PAPERCLIP_API_KEY;
  const originalFetch = globalThis.fetch;
  const originalWrite = process.stdout.write;
  const boardHeaders = [];
  try {
    if (envKey === undefined) delete process.env.PAPERCLIP_API_KEY;
    else process.env.PAPERCLIP_API_KEY = envKey;
    process.stdout.write = () => true;
    globalThis.fetch = async (url, init = {}) => {
      let data;
      if (url === "https://health.test/api/health") {
        data = { status: "ok", version: "1.7.0" };
      } else if (url === "https://board.test/api/companies/company/labels") {
        boardHeaders.push(init.headers.Authorization);
        data = [{ id: "release", name: "1.7" }];
      } else if (url === "https://board.test/api/companies/company/issues?labelId=release&limit=100&offset=0&view=compact") {
        boardHeaders.push(init.headers.Authorization);
        data = [{ id: "issue", status: "done" }];
      } else {
        throw new Error(`unexpected URL: ${url}`);
      }
      return { ok: true, json: async () => data };
    };
    assert.equal(await main([...baseArgs, ...keyArgs]), EXIT_OK);
    assert.deepEqual(boardHeaders, [expected, expected]);
  } finally {
    process.stdout.write = originalWrite;
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.PAPERCLIP_API_KEY;
    else process.env.PAPERCLIP_API_KEY = originalKey;
  }
}

test("missing --api-key uses the environment key", async () => {
  await checkKey({ envKey: "environment-value", expected: "Bearer environment-value" });
});

test("explicit --api-key takes precedence over the environment", async () => {
  await checkKey({ envKey: "environment-value", keyArgs: ["--api-key", "argument-value"], expected: "Bearer argument-value" });
});

test("bare --api-key uses the environment key", async () => {
  await checkKey({ envKey: "environment-value", keyArgs: ["--api-key"], expected: "Bearer environment-value" });
});

test("without either key board requests have no Authorization", async () => {
  await checkKey({ expected: undefined });
});
