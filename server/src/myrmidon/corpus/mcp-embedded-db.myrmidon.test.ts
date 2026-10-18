// server/src/myrmidon/corpus/mcp-embedded-db.myrmidon.test.ts
//
// myrmidon(1.6.6 CORPUS-2.0, part D): the endpoint over a real database.
//
// The transport suite runs over settings handed to it as an object. This one
// takes the switch from where it will actually live — `instance_settings.general
// .corpus`, the additive block part C owns — through a real embedded PostgreSQL,
// and checks what a bot sees at each state of that row:
//
//   * no block, or `enabled: false` — `tools/list` is empty and a call that names
//     a corpus tool anyway answers `corpus_disabled` (the bot's tool set is the
//     one it had before the module existed);
//   * `enabled: true` — the four tools appear, and `corpus_search` answers with
//     the chunks of a document indexed beforehand, scores and document links
//     included;
//   * a limit the operator set, and one they set past the ceiling.
//
// The corpus behind the port is the in-memory fixture: parts A and B own the
// real store and index, and this part must not depend on them to prove its own
// contract.

import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, instanceSettings, type Db } from "@paperclipai/db";
import { errorHandler } from "../../middleware/index.js";
import { startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport } from "../../__tests__/helpers/embedded-postgres.js";
import { type CorpusMcpDeps } from "./contract.js";
import { createInMemoryCorpus } from "./in-memory-port.test-fixture.js";
import { myrmidonCorpusMcpRoutes } from "./mcp.js";
import { CORPUS_SETTINGS_KEY, readCorpusModuleSettings } from "./settings.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

const COMPANY_ID = "33333333-3333-4333-8333-333333333333";
const URL = `/api/myrmidon/companies/${COMPANY_ID}/corpus/mcp`;

const member = {
  type: "board",
  source: "session",
  userId: "user-b",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
};

describeEmbeddedPostgres("corpus MCP endpoint over the settings row", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: Db;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-corpus-mcp-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /** Writes the module's block as part C will, and reads it back the way the endpoint does. */
  async function setBlock(block: Record<string, unknown> | null) {
    const rows = await db.select().from(instanceSettings).where(eq(instanceSettings.singletonKey, "default"));
    const general = { ...(rows[0]?.general ?? {}) };
    if (block === null) delete general[CORPUS_SETTINGS_KEY];
    else general[CORPUS_SETTINGS_KEY] = block;
    if (rows.length === 0) await db.insert(instanceSettings).values({ singletonKey: "default", general });
    else await db.update(instanceSettings).set({ general }).where(eq(instanceSettings.singletonKey, "default"));
  }

  /** The gate as part C mounts it: the stored block, read through this part's reader. */
  async function storedSettings() {
    const rows = await db
      .select({ general: instanceSettings.general })
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, "default"));
    return readCorpusModuleSettings(rows[0]?.general?.[CORPUS_SETTINGS_KEY]);
  }

  function harness(memory: ReturnType<typeof createInMemoryCorpus>) {
    const deps: CorpusMcpDeps = { settings: () => ({ ...storedSettingsSnapshot }), port: () => memory.port };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = member;
      next();
    });
    app.use("/api", myrmidonCorpusMcpRoutes(deps));
    app.use(errorHandler);
    return { app, deps };
  }

  // `settings()` is synchronous, so the row is read once per harness build — the
  // snapshot is refreshed by `reload()` below, which is the same "read the row,
  // then serve" order the server uses per call.
  let storedSettingsSnapshot = readCorpusModuleSettings(null);
  async function reload() {
    storedSettingsSnapshot = await storedSettings();
  }

  it("has no corpus tools before the module is switched on, and keeps the bot's calls answered", async () => {
    await setBlock(null);
    const memory = createInMemoryCorpus();
    memory.addDataset({ id: "ds-contracts", name: "Договоры" });
    memory.indexDocument({ datasetId: "ds-contracts", name: "Договор.pdf", chunks: ["Поставка товара в срок."] });
    await reload();

    const { app } = harness(memory);
    const listed = await request(app).post(URL).send({ id: 1, method: "tools/list" }).expect(200);
    expect(listed.body.result.tools).toEqual([]);

    const called = await request(app)
      .post(URL)
      .send({ id: 2, method: "tools/call", params: { name: "corpus_search", arguments: { query: "поставка" } } })
      .expect(200);
    expect(called.body.result.isError).toBe(true);
    expect(called.body.result.structuredContent.code).toBe("corpus_disabled");
    expect(memory.calls.search).toEqual([]);
  });

  it("serves searches over the indexed document once the operator enables the module", async () => {
    await setBlock({ enabled: true, defaultTopK: 2, maxTopK: 4 });
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
    await reload();

    const { app } = harness(memory);
    const listed = await request(app).post(URL).send({ id: 3, method: "tools/list" }).expect(200);
    expect(listed.body.result.tools).toHaveLength(4);

    const found = await request(app)
      .post(URL)
      .send({ id: 4, method: "tools/call", params: { name: "corpus_search", arguments: { query: "сроки поставки товара" } } })
      .expect(200);
    const hits = found.body.result.structuredContent.hits as Array<{
      score: number;
      text: string;
      document: { name: string; url: string | null };
    }>;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toMatchObject({ document: { name: "Договор поставки №12.pdf" } });
    expect(hits[0].score).toBeGreaterThan(0);
    expect(hits[0].document.url).toContain("/corpus/documents/");
    expect(memory.calls.search[0].topK).toBe(2);

    // The operator's ceiling is the operator's: a bot cannot raise it.
    const over = await request(app)
      .post(URL)
      .send({ id: 5, method: "tools/call", params: { name: "corpus_search", arguments: { query: "поставка", top_k: 5 } } })
      .expect(200);
    expect(over.body.result.isError).toBe(true);
    expect(over.body.result.structuredContent.code).toBe("invalid_tool_input");
  });

  it("reads a broken block as off with the defaults, never as on", async () => {
    await setBlock({ enabled: "yes", defaultTopK: 0, maxTopK: "many" });
    await reload();
    expect(storedSettingsSnapshot).toEqual({ enabled: false, defaultTopK: 5, maxTopK: 50 });

    const { app } = harness(createInMemoryCorpus());
    const listed = await request(app).post(URL).send({ id: 6, method: "tools/list" }).expect(200);
    expect(listed.body.result.tools).toEqual([]);
  });
});