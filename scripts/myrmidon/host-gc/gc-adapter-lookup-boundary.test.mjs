import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchAgentAdapter } from "./host-clone-cache-gc.mjs";

const companyKeys = ["MYRMIDON_COMPANY_ID", "PAPERCLIP_COMPANY_ID"];

async function withCompany(company, fn) {
  const saved = companyKeys.map((key) => process.env[key]);
  try {
    for (const key of companyKeys) delete process.env[key];
    if (company !== undefined) process.env.MYRMIDON_COMPANY_ID = company;
    return await fn();
  } finally {
    companyKeys.forEach((key, i) => {
      if (saved[i] === undefined) delete process.env[key];
      else process.env[key] = saved[i];
    });
  }
}

const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

function fakeFetch(result) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (...args) => {
      calls.push(args);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

const options = (fetchImpl, baseUrl = "https://board.invalid") => ({
  baseUrl,
  apiKey: "synthetic-test-key",
  fetchImpl,
});

describe("fetchAgentAdapter company list boundary", () => {
  it("matches the exact canonical name, not an eng1 prefix, with one authenticated list request", async () => {
    await withCompany("company / one", async () => {
      const mock = fakeFetch(response([
        { id: "ten", name: "adm-dev-eng-10", adapterType: "wrong" },
        { id: "one", name: "adm-dev-eng-1", adapterType: "omp_local" },
      ]));
      assert.deepEqual(await fetchAgentAdapter("eng1", options(mock.fetchImpl, "https://board.invalid/")), { ok: true, adapterType: "omp_local" });
      assert.equal(mock.calls.length, 1);
      assert.deepEqual(mock.calls[0], ["https://board.invalid/api/companies/company%20%2F%20one/agents?q=adm-dev-eng-1", {
        headers: { Accept: "application/json", Authorization: "Bearer synthetic-test-key" },
      }]);
    });
  });

  it("returns null when the exact agent is absent, even if a prefix match exists", async () => {
    await withCompany("company", async () => {
      const mock = fakeFetch(response([{ id: "ten", name: "adm-dev-eng-10", adapterType: "omp_local" }]));
      assert.deepEqual(await fetchAgentAdapter("eng1", options(mock.fetchImpl)), { ok: true, adapterType: null });
      assert.equal(mock.calls.length, 1);
    });
  });

  it("normalizes an existing API suffix without adding it twice", async () => {
    await withCompany("company", async () => {
      const mock = fakeFetch(response([{ id: "8", name: "adm-dev-eng-8", adapterType: "hermes_gateway" }]));
      assert.deepEqual(await fetchAgentAdapter("eng8", options(mock.fetchImpl, "https://board.invalid/api/")), { ok: true, adapterType: "hermes_gateway" });
      assert.equal(mock.calls.length, 1);
      assert.equal(mock.calls[0][0], "https://board.invalid/api/companies/company/agents?q=adm-dev-eng-8");
    });
  });

  it("does not fetch when the company is missing", async () => {
    await withCompany(undefined, async () => {
      const mock = fakeFetch(response([]));
      assert.deepEqual(await fetchAgentAdapter("eng1", options(mock.fetchImpl)), { ok: false, reason: "company-id-missing" });
      assert.equal(mock.calls.length, 0);
    });
  });

  it("rejects bad IDs without a request", async () => {
    await withCompany("company", async () => {
      for (const id of ["", "../eng1", "eng", "eng1/extra", "other1"]) {
        const mock = fakeFetch(response([]));
        assert.deepEqual(await fetchAgentAdapter(id, options(mock.fetchImpl)), { ok: false, reason: "bad-agent-id" }, id);
        assert.equal(mock.calls.length, 0, id);
      }
    });
  });

  it("fails closed on non-array lists and missing fields on a matching entry", async () => {
    await withCompany("company", async () => {
      for (const body of [{}, null, { agents: [] }, [{ name: "adm-dev-eng-1", adapterType: "omp_local" }], [{ id: "1", name: "adm-dev-eng-1" }]]) {
        const mock = fakeFetch(response(body));
        assert.deepEqual(await fetchAgentAdapter("eng1", options(mock.fetchImpl)), { ok: false, reason: "board-invalid-agent-list" });
        assert.equal(mock.calls.length, 1);
      }
      const empty = fakeFetch(response([]));
      assert.deepEqual(await fetchAgentAdapter("eng1", options(empty.fetchImpl)), { ok: true, adapterType: null });
      assert.equal(empty.calls.length, 1);
    });
  });

  it("fails closed on HTTP, network, and JSON errors", async () => {
    await withCompany("company", async () => {
      const cases = [
        [response([], 503), { ok: false, reason: "board-http-503", statusCode: 503 }],
        [new Error("offline"), { ok: false, reason: "board-unavailable" }],
        [{ ok: true, json: async () => { throw new SyntaxError("invalid JSON"); } }, { ok: false, reason: "board-unavailable" }],
      ];
      for (const [reply, expected] of cases) {
        const mock = fakeFetch(reply);
        assert.deepEqual(await fetchAgentAdapter("eng1", options(mock.fetchImpl)), expected);
        assert.equal(mock.calls.length, 1);
      }
    });
  });
});
