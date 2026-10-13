// server/src/myrmidon/corpus/tools.myrmidon.test.ts
//
// myrmidon(1.6.6 CORPUS-2.0, part D): the tool surface on its own — names,
// argument handling, the settings' effect on both, and the codes a bot reads
// when a call cannot be served. No Express and no database here: the endpoint's
// own behaviour is `mcp.myrmidon.test.ts`, and the settings read from a real
// row is `mcp-embedded-db.myrmidon.test.ts`.

import { describe, expect, it } from "vitest";
import { DEFAULT_CORPUS_MODULE_SETTINGS } from "./contract.js";
import { createInMemoryCorpus } from "./in-memory-port.test-fixture.js";
import {
  CORPUS_TOOL_NAMES,
  CorpusError,
  callCorpusTool,
  corpusToolDefinitions,
  isCorpusToolName,
} from "./tools.js";

const ENABLED = { ...DEFAULT_CORPUS_MODULE_SETTINGS, enabled: true, defaultTopK: 3, maxTopK: 5 };

function corpus() {
  const memory = createInMemoryCorpus();
  memory.addDataset({ id: "ds-contracts", name: "Договоры" });
  memory.addDataset({ id: "ds-tenders", name: "Тендеры" });
  memory.indexDocument({
    datasetId: "ds-contracts",
    name: "Договор поставки №12.pdf",
    chunks: [
      "Оплата по договору производится в течение 30 календарных дней после поставки.",
      "Поставщик обязан передать товар до 31 декабря.",
      "Ответственность сторон за нарушение сроков поставки.",
      "Прочие условия, не относящиеся к вопросу.",
    ],
  });
  return memory;
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    throw new Error("expected the call to fail");
  } catch (error) {
    if (!(error instanceof CorpusError)) throw error;
    return error.code;
  }
}

describe("corpus tool surface", () => {
  it("fixes the four tool names and their input schemas", () => {
    expect(corpusToolDefinitions.map((tool) => tool.name)).toEqual([
      "corpus_search",
      "corpus_get_document",
      "corpus_list_datasets",
      "corpus_list_documents",
    ]);
    const search = corpusToolDefinitions[0].inputSchema as { required: string[] };
    expect(search.required).toContain("query");
    expect(isCorpusToolName("corpus_search")).toBe(true);
    expect(isCorpusToolName("ragflow_retrieval")).toBe(false);
  });

  it("returns hits with a score and the document they came from", async () => {
    const memory = corpus();
    const result = (await callCorpusTool(
      CORPUS_TOOL_NAMES.search,
      { query: "передать товар" },
      { settings: ENABLED, port: memory.port },
    )) as { hits: Array<{ score: number; text: string; document: { id: string; name: string; url: string | null } }> };

    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0].score).toBeGreaterThan(0);
    // The fixture scores a chunk by the share of query terms it carries, best first.
    expect(result.hits[0].text).toContain("Поставщик обязан передать товар");
    expect(result.hits[0].document.name).toBe("Договор поставки №12.pdf");
    expect(result.hits[0].document.url).toContain("/corpus/documents/");
    // The module's default top-k, not the fixture's.
    expect(memory.calls.search[0].topK).toBe(3);
  });

  it("accepts the RAGFlow spelling of the arguments beside its own", async () => {
    const memory = corpus();
    await callCorpusTool(
      CORPUS_TOOL_NAMES.search,
      { query: "поставки", dataset_ids: ["ds-contracts", "ds-contracts"], dataset: "ds-tenders", top_k: 4, similarity_threshold: 0.5 },
      { settings: ENABLED, port: memory.port },
    );
    expect(memory.calls.search[0].datasets).toEqual(["ds-contracts", "ds-tenders"]);
    expect(memory.calls.search[0].topK).toBe(4);
    expect(memory.calls.search[0].minScore).toBe(0.5);
  });

  it("refuses a top_k above the settings' ceiling instead of clamping it", async () => {
    const memory = corpus();
    const code = await codeOf(() =>
      callCorpusTool(CORPUS_TOOL_NAMES.search, { query: "поставки", top_k: 6 }, { settings: ENABLED, port: memory.port }),
    );
    expect(code).toBe("invalid_tool_input");
    expect(memory.calls.search).toEqual([]);
  });

  it("reads a document, with its text unless the bot says otherwise", async () => {
    const memory = corpus();
    const id = memory.indexDocument({ datasetId: "ds-tenders", name: "Тендер.pdf", chunks: ["Текст тендера"] });
    const withText = (await callCorpusTool(
      CORPUS_TOOL_NAMES.getDocument,
      { document_id: id },
      { settings: ENABLED, port: memory.port },
    )) as { document: { status: string; chunks: number }; text: string | null };
    expect(withText.text).toContain("Текст тендера");
    expect(withText.document.status).toBe("ready");

    const metadataOnly = (await callCorpusTool(
      CORPUS_TOOL_NAMES.getDocument,
      { document_id: id, include_text: false },
      { settings: ENABLED, port: memory.port },
    )) as { text: string | null };
    expect(metadataOnly.text).toBeNull();
  });

  it("lists datasets and a page of documents", async () => {
    const memory = corpus();
    const datasets = (await callCorpusTool(CORPUS_TOOL_NAMES.listDatasets, {}, { settings: ENABLED, port: memory.port })) as Array<{
      id: string;
      documents: number;
      readyDocuments: number;
      chunks: number;
    }>;
    expect(datasets.map((dataset) => dataset.id)).toEqual(["ds-contracts", "ds-tenders"]);
    expect(datasets[0]).toMatchObject({ documents: 1, readyDocuments: 1, chunks: 4 });

    const page = (await callCorpusTool(
      CORPUS_TOOL_NAMES.listDocuments,
      { dataset: "ds-contracts", limit: 2 },
      { settings: ENABLED, port: memory.port },
    )) as { dataset: { name: string } | null; documents: unknown[]; limit: number };
    expect(page.dataset?.name).toBe("Договоры");
    expect(page.documents).toHaveLength(1);
    expect(memory.calls.listDocuments[0]).toEqual({ datasetId: "ds-contracts", offset: 0, limit: 2 });
  });

  it("asks for a limit when an offset is given, and keeps to the ceiling", async () => {
    const memory = corpus();
    expect(
      await codeOf(() =>
        callCorpusTool(CORPUS_TOOL_NAMES.listDocuments, { offset: 5 }, { settings: ENABLED, port: memory.port }),
      ),
    ).toBe("invalid_tool_input");
    expect(
      await codeOf(() =>
        callCorpusTool(CORPUS_TOOL_NAMES.listDocuments, { limit: 9 }, { settings: ENABLED, port: memory.port }),
      ),
    ).toBe("invalid_tool_input");
  });

  it("reports invalid arguments with the tool's name and the offending field", async () => {
    const memory = corpus();
    try {
      await callCorpusTool(CORPUS_TOOL_NAMES.search, { query: "  " }, { settings: ENABLED, port: memory.port });
      throw new Error("expected the call to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CorpusError);
      expect((error as CorpusError).code).toBe("invalid_tool_input");
      expect((error as CorpusError).message).toContain("corpus_search: query");
    }
  });

  it("has no tool when the module is off, and answers meaningfully anyway", async () => {
    const memory = corpus();
    for (const name of Object.values(CORPUS_TOOL_NAMES)) {
      const code = await codeOf(() =>
        callCorpusTool(name, { query: "поставки", document_id: "doc-1" }, { settings: DEFAULT_CORPUS_MODULE_SETTINGS, port: memory.port }),
      );
      expect(code).toBe("corpus_disabled");
    }
    // Nothing reached the corpus: the switch stops the call before the data side.
    expect(memory.calls.search).toEqual([]);
    expect(memory.calls.getDocument).toEqual([]);
  });

  it("says so when the module is on but the data side is missing", async () => {
    const code = await codeOf(() =>
      callCorpusTool(CORPUS_TOOL_NAMES.listDatasets, {}, { settings: ENABLED, port: null }),
    );
    expect(code).toBe("corpus_unavailable");
  });

  it("refuses a tool it does not know", async () => {
    const memory = corpus();
    expect(
      await codeOf(() => callCorpusTool("corpus_delete_everything", {}, { settings: ENABLED, port: memory.port })),
    ).toBe("invalid_tool_input");
  });
});