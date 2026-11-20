import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchReleaseTasks } from "./verify-on-prod.mjs";

const base = {
  apiUrl: "https://example.invalid",
  apiKey: "fictional-key",
  companyId: "fictional-company",
  labelId: "fictional-label",
};

for (const [name, pageSize] of [
  ["null", null],
  ["true", true],
  ["false", false],
  ["numeric string", "100"],
  ["decimal numeric string", "1.5"],
  ["empty string", ""],
  ["object", {}],
  ["array", []],
  ["bigint", 1n],
  ["symbol", Symbol("pageSize")],
  ["NaN", NaN],
  ["Infinity", Infinity],
  ["negative Infinity", -Infinity],
  ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
]) {
  test(`public pageSize rejects ${name} before fetch`, async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return { ok: true, json: async () => [] };
    };
    try {
      await assert.rejects(fetchReleaseTasks({ ...base, pageSize, fetchImpl }), /pageSize/);
    } finally {
      assert.equal(calls, 0);
    }
  });
}

for (const [name, options, expectedLimit] of [
  ["omitted", {}, "100"],
  ["one", { pageSize: 1 }, "1"],
  ["maximum safe integer", { pageSize: Number.MAX_SAFE_INTEGER }, "9007199254740991"],
]) {
  test(`public pageSize ${name} requests the exact limit`, async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      return { ok: true, json: async () => [] };
    };
    const result = await fetchReleaseTasks({ ...base, ...options, fetchImpl });
    assert.deepEqual(result, []);
    assert.equal(calls.length, 1);
    const url = new URL(calls[0]);
    assert.equal(url.origin, "https://example.invalid");
    assert.equal(url.pathname, "/api/companies/fictional-company/issues");
    assert.equal(url.searchParams.get("limit"), expectedLimit);
    assert.equal(url.searchParams.get("offset"), "0");
  });
}
