import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchBotAgent } from "./host-clone-cache-gc.mjs";

const baseUrl = "https://board.invalid";
const company = "synthetic company/id";
const uuid = "12345678-1234-4234-8234-123456789abc";
const agent = { id: uuid, name: "bot-name", role: "reviewer" };
const picked = { ok: true, ...agent };

async function lookup(key, response, companyId = company) {
  const saved = [process.env.MYRMIDON_COMPANY_ID, process.env.PAPERCLIP_COMPANY_ID];
  const calls = [];
  try {
    if (companyId === null) delete process.env.MYRMIDON_COMPANY_ID;
    else process.env.MYRMIDON_COMPANY_ID = companyId;
    delete process.env.PAPERCLIP_COMPANY_ID;
    const result = await fetchBotAgent(key, {
      baseUrl,
      apiKey: "synthetic-key",
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        if (response instanceof Error) throw response;
        return response;
      },
    });
    for (const call of calls) {
      assert.deepEqual(call.options, { headers: { Accept: "application/json", Authorization: "Bearer synthetic-key" } });
    }
    return { result, routes: calls.map(({ url }) => url) };
  } finally {
    for (const [name, value] of [["MYRMIDON_COMPANY_ID", saved[0]], ["PAPERCLIP_COMPANY_ID", saved[1]]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const listRoute = (key) => `${baseUrl}/api/companies/${encodeURIComponent(company)}/agents?q=${encodeURIComponent(key)}`;
const detailRoute = `${baseUrl}/api/agents/${uuid}`;

describe("fetchBotAgent lookup boundary", () => {
  it("uses only the detail endpoint for UUIDs", async () => {
    assert.deepEqual(await lookup(uuid, response(agent)), { result: picked, routes: [detailRoute] });
  });

  it("uses the company-scoped list and chooses an exact name, not a prefix or case variant", async () => {
    const result = await lookup("bot-name", response([
      { id: "prefix", name: "bot-name-extra", role: "engineer" },
      { id: "case", name: "Bot-Name", role: "engineer" }, agent,
    ]));
    assert.deepEqual(result, { result: picked, routes: [listRoute("bot-name")] });
    assert.deepEqual(await lookup("bot-name", response([{ id: "prefix", name: "bot-name-extra" }, { id: "case", name: "Bot-Name" }])),
      { result: { ok: true, id: null }, routes: [listRoute("bot-name")] });
  });

  it("matches an exact non-UUID id in the list without a detail request", async () => {
    assert.deepEqual(await lookup("bot/id", response([{ id: "bot/id", name: "other", role: "engineer" }])), {
      result: { ok: true, id: "bot/id", name: "other", role: "engineer" }, routes: [listRoute("bot/id")],
    });
  });

  it("treats a detail 404 as absent but a list HTTP failure as unavailable", async () => {
    assert.deepEqual(await lookup(uuid, response(null, 404)), { result: { ok: true, id: null }, routes: [detailRoute] });
    assert.deepEqual(await lookup("missing", response(null, 404)), { result: { ok: false, reason: "board-http-404" }, routes: [listRoute("missing")] });
    assert.deepEqual(await lookup("missing", response(null, 503)), { result: { ok: false, reason: "board-http-503" }, routes: [listRoute("missing")] });
  });

  it("distinguishes an empty list from a non-array list", async () => {
    assert.deepEqual(await lookup("missing", response([])), { result: { ok: true, id: null }, routes: [listRoute("missing")] });
    assert.deepEqual(await lookup("missing", response({ agents: [] })), { result: { ok: false, reason: "board-invalid-agent-list" }, routes: [listRoute("missing")] });
  });

  it("fails closed for invalid detail JSON", async () => {
    const invalid = { ok: true, status: 200, json: async () => { throw new SyntaxError("invalid JSON"); } };
    assert.deepEqual(await lookup(uuid, invalid), { result: { ok: false, reason: "board-unavailable" }, routes: [detailRoute] });
    assert.deepEqual(await lookup(uuid, response({ name: "missing id" })), { result: { ok: false, reason: "board-invalid-agent" }, routes: [detailRoute] });
  });

  it("does not fetch a name without a company", async () => {
    assert.deepEqual(await lookup("bot-name", response([]), null), { result: { ok: false, reason: "company-id-missing" }, routes: [] });
  });

  it("fails closed when fetch throws", async () => {
    assert.deepEqual(await lookup("bot-name", new Error("offline")), { result: { ok: false, reason: "board-unavailable" }, routes: [listRoute("bot-name")] });
    assert.deepEqual(await lookup(uuid, new Error("offline")), { result: { ok: false, reason: "board-unavailable" }, routes: [detailRoute] });
  });
});
