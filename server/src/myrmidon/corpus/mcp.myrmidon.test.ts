// server/src/myrmidon/corpus/mcp.myrmidon.test.ts
//
// myrmidon(1.6.6 CORPUS-2.0, part D): the corpus MCP endpoint over the wire.
//
// The suite speaks the transport a bot speaks — initialize, tools/list,
// tools/call — against a fixture corpus that indexes a document first, so the
// two answers the task asks about are checked here rather than argued: with the
// module on, `corpus_search` comes back with the indexed document's chunks; with
// the module off, the tool list is empty and a call that names a tool anyway is
// a tool result carrying `corpus_disabled`.

import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { CORPUS_MCP_SERVER_NAME, DEFAULT_CORPUS_MODULE_SETTINGS, type CorpusMcpDeps } from "./contract.js";
import { createInMemoryCorpus } from "./in-memory-port.test-fixture.js";
import { myrmidonCorpusMcpRoutes } from "./mcp.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const URL = `/api/myrmidon/companies/${COMPANY_ID}/corpus/mcp`;

const member = {
  type: "board",
  source: "session",
  userId: "user-a",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
};

const ENABLED = { ...DEFAULT_CORPUS_MODULE_SETTINGS, enabled: true };

/** A corpus with a test document already indexed into it. */
function corpus() {
  const memory = createInMemoryCorpus();
  memory.addDataset({ id: "ds-contracts", name: "Договоры" });
  memory.indexDocument({
    datasetId: "ds-contracts",
    name: "Договор поставки №12.pdf",
    chunks: [
      "Оплата производится в течение 30 календарных дней после поставки товара.",
      "Поставщик обязан передать товар до 31 декабря.",
    ],
  });
  return memory;
}

function harness(deps: CorpusMcpDeps, actor: unknown = member) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", myrmidonCorpusMcpRoutes(deps));
  app.use(errorHandler);
  return app;
}

describe("company corpus MCP endpoint", () => {
  it("answers initialize with the server identity", async () => {
    const app = harness({ settings: () => ENABLED, port: () => corpus().port });
    const res = await request(app).post(URL).send({ id: 1, method: "initialize" }).expect(200);
    expect(res.body.result.serverInfo.name).toBe(CORPUS_MCP_SERVER_NAME);
    expect(res.body.result.capabilities.tools).toEqual({ listChanged: false });
  });

  it("answers a notification with 202", async () => {
    const app = harness({ settings: () => ENABLED, port: () => corpus().port });
    await request(app).post(URL).send({ method: "notifications/initialized" }).expect(202);
  });

  it("lists the four corpus tools when the module is on", async () => {
    const app = harness({ settings: () => ENABLED, port: () => corpus().port });
    const res = await request(app).post(URL).send({ id: 2, method: "tools/list" }).expect(200);
    expect(res.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "corpus_search",
      "corpus_get_document",
      "corpus_list_datasets",
      "corpus_list_documents",
    ]);
    const described = res.body.result.tools[0].description as string;
    expect(described).toContain("chunks");
  });

  it("returns the indexed document's chunks to a search", async () => {
    const app = harness({ settings: () => ENABLED, port: () => corpus().port });
    const res = await request(app)
      .post(URL)
      .send({ id: 3, method: "tools/call", params: { name: "corpus_search", arguments: { query: "передать товар" } } })
      .expect(200);

    expect(res.body.result.isError).toBeUndefined();
    const hits = res.body.result.structuredContent.hits as Array<{
      text: string;
      score: number;
      document: { name: string };
    }>;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].score).toBeGreaterThan(0);
    expect(hits[0].text).toContain("Поставщик обязан передать товар");
    expect(hits[0].document.name).toBe("Договор поставки №12.pdf");
    // The text half of the result is the same payload a bot reads.
    const textHits = JSON.parse(res.body.result.content[0].text).hits as Array<{ text: string }>;
    expect(textHits.length).toBe(hits.length);
    expect(textHits[0].text).toContain("Поставщик обязан");
  });

  it("lists no tools at all when the module is off", async () => {
    const app = harness({
      settings: () => DEFAULT_CORPUS_MODULE_SETTINGS,
      port: () => {
        throw new Error("the port must not be resolved while the module is off");
      },
    });
    const res = await request(app).post(URL).send({ id: 4, method: "tools/list" }).expect(200);
    expect(res.body.result.tools).toEqual([]);
  });

  it("answers a corpus_* call with corpus_disabled while the module is off", async () => {
    const memory = corpus();
    const app = harness({ settings: () => DEFAULT_CORPUS_MODULE_SETTINGS, port: () => memory.port });
    const res = await request(app)
      .post(URL)
      .send({ id: 5, method: "tools/call", params: { name: "corpus_search", arguments: { query: "поставки" } } })
      .expect(200);

    expect(res.body.result.isError).toBe(true);
    expect(res.body.result.structuredContent.code).toBe("corpus_disabled");
    expect(res.body.result.content[0].text).toContain("not enabled");
    // The switch is read before the data side: nothing was searched.
    expect(memory.calls.search).toEqual([]);
  });

  it("turns the tools on without a restart, because the settings are read per call", async () => {
    let enabled = false;
    const app = harness({ settings: () => (enabled ? ENABLED : DEFAULT_CORPUS_MODULE_SETTINGS), port: () => corpus().port });
    const off = await request(app).post(URL).send({ id: 6, method: "tools/list" }).expect(200);
    expect(off.body.result.tools).toEqual([]);

    enabled = true;
    const on = await request(app).post(URL).send({ id: 7, method: "tools/list" }).expect(200);
    expect(on.body.result.tools).toHaveLength(4);
  });

  it("answers an unknown method and an unknown tool with a JSON-RPC error", async () => {
    const app = harness({ settings: () => ENABLED, port: () => corpus().port });
    const method = await request(app).post(URL).send({ id: 8, method: "resources/list" }).expect(200);
    expect(method.body.error.code).toBe(-32601);

    const tool = await request(app)
      .post(URL)
      .send({ id: 9, method: "tools/call", params: { name: "ragflow_retrieval", arguments: {} } })
      .expect(200);
    expect(tool.body.error.code).toBe(-32602);
  });

  it("returns a failed call as a tool result with its code", async () => {
    const app = harness({ settings: () => ENABLED, port: () => corpus().port });
    const res = await request(app)
      .post(URL)
      .send({ id: 10, method: "tools/call", params: { name: "corpus_get_document", arguments: { document_id: "doc-missing" } } })
      .expect(200);
    expect(res.body.result.isError).toBe(true);
    expect(res.body.result.structuredContent.code).toBe("document_not_found");
  });

  it("refuses a caller without access to the company", async () => {
    const outsider = { ...member, userId: "user-c", companyIds: [] };
    const app = harness({ settings: () => ENABLED, port: () => corpus().port }, outsider);
    await request(app).post(URL).send({ id: 11, method: "tools/list" }).expect(403);
  });
});