// server/src/myrmidon/corpus/mcp-document-name.myrmidon.test.ts
//
// OPE-12028: corpus_search must cite a document by its real name (the filename
// the uploader gave it), not by the internal UUID; and corpus_get_document with
// include_text must not crash when the document has no stored blob.
//
// These tests drive createCorpusMcpProvider (the production adapter) with
// in-memory ports, so they run without embedded Postgres and still exercise the
// exact mapping the bug lived in.

import { describe, expect, it } from "vitest";
import { createCorpusMcpProvider } from "./adapters.js";
import type { CorpusPorts } from "./ports.js";
import type { CorpusSettings } from "@myrmidon/shared";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const DATASET_ID = "ds-books";
const DOCUMENT_ID = "doc-weber";
const DOCUMENT_NAME = "Weber_book.pdf";

const settings: CorpusSettings = {
  enabled: true,
  parserBaseUrl: "http://parser.invalid",
  parserTimeoutMs: 1000,
  parserMaxRunMs: 6 * 60 * 60 * 1000,
  parserQueueTimeoutMs: 4 * 60 * 60 * 1000,
  embedderModel: "corpus-embed-pplx-0.6b",
  embedderDimensions: 3,
  embedderBaseUrl: null,
  maxDocumentBytes: 1024,
  maxDocumentsPerDataset: 5,
  parseConcurrency: 1,
  maxParseAttempts: 2,
  searchTopK: 5,
};

function makePorts(overrides: {
  blobRef?: string;
  blobBytes?: Uint8Array;
} = {}): CorpusPorts {
  const blobRef = overrides.blobRef ?? "";
  const blobBytes = overrides.blobBytes ?? new Uint8Array();
  return {
    store: {
      async listDatasets() {
        return [{
          id: DATASET_ID,
          companyId: COMPANY_ID,
          name: "bbq-craft",
          description: null,
          createdAt: "2026-11-07T00:00:00.000Z",
          updatedAt: "2026-11-07T00:00:00.000Z",
          documentCount: 1,
          readyCount: 1,
          failedCount: 0,
          chunkCount: 1,
        }];
      },
      async getDataset() { return null; },
      async hasDataset(_companyId: string, datasetId: string) { return datasetId === DATASET_ID; },
      async createDataset() { throw new Error("not used"); },
      async updateDataset() { return null; },
      async deleteDataset() { return false; },
      async listDocuments() { return []; },
      async listSourceDocuments() { return []; },
      async getDocument(_companyId: string, id: string) {
        if (id !== DOCUMENT_ID) return null;
        return {
          id: DOCUMENT_ID,
          companyId: COMPANY_ID,
          datasetId: DATASET_ID,
          filename: DOCUMENT_NAME,
          mimeType: "application/pdf",
          byteSize: 1024,
          blobRef,
          status: "ready",
          chunkCount: 1,
          error: null,
          attempts: 0,
          createdAt: "2026-11-07T00:00:00.000Z",
          updatedAt: "2026-11-07T00:00:00.000Z",
          parsedAt: null,
        };
      },
      async getDocumentNames(_companyId: string, ids: string[]) {
        return new Map(ids.includes(DOCUMENT_ID) ? [[DOCUMENT_ID, DOCUMENT_NAME]] : []);
      },
      async createDocument() { throw new Error("not used"); },
      async updateDocument() { return null; },
      async deleteDocument() { return false; },
      async countDocuments() { return 1; },
      async getJob() { return null; },
      async counters() {
        return {
          datasets: 1,
          documents: 1,
          ready: 1,
          pending: 0,
          failed: 0,
          chunks: 1,
          bytes: 1024,
        };
      },
    },
    blobs: {
      async put() { throw new Error("not used"); },
      async get(ref: string) {
        if (ref === "") throw new Error("corpus blob: empty key");
        return blobBytes;
      },
      async delete() {},
    },
    queue: {
      async enqueue() { throw new Error("not used"); },
      async claim() { return []; },
      async complete() {},
      async fail() { return null; },
      async release() { return null; },
      async releaseRunning() { return []; },
    },
    parser: {
      async parse() { throw new Error("not used"); },
    },
    index: {
      async indexDocument() { return 1; },
      async deleteDocument() {},
      async search() {
        return [{
          chunkId: "chunk-1",
          documentId: DOCUMENT_ID,
          datasetId: DATASET_ID,
          score: 0.95,
          text: "Grill temperature and timing advice from Weber.",
          metadata: {},
        }];
      },
      async countChunks() { return 1; },
      async assertEmbedderConfigured() {},
    },
  };
}

describe("createCorpusMcpProvider (OPE-12028)", () => {
  it("search returns document.name = filename, not UUID", async () => {
    const provider = createCorpusMcpProvider(
      async () => settings,
      () => makePorts(),
    );
    const tools = await provider(COMPANY_ID);
    expect(tools).not.toBeNull();

    const result = await tools!.search({
      query: "weber grill",
      datasets: [],
      topK: 5,
      minScore: null,
    });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]!.document.id).toBe(DOCUMENT_ID);
    expect(result.hits[0]!.document.name).toBe(DOCUMENT_NAME);
    expect(result.hits[0]!.document.name).not.toBe(DOCUMENT_ID);
  });

  it("get_document with include_text=true does not crash when blobRef is empty", async () => {
    const provider = createCorpusMcpProvider(
      async () => settings,
      () => makePorts({ blobRef: "" }),
    );
    const tools = await provider(COMPANY_ID);
    expect(tools).not.toBeNull();

    // Before the fix this threw "corpus blob: empty key".
    const view = await tools!.getDocument({ documentId: DOCUMENT_ID, includeText: true });
    expect(view.document.id).toBe(DOCUMENT_ID);
    expect(view.document.name).toBe(DOCUMENT_NAME);
    expect(view.text).toBeNull();
  });

  it("get_document with include_text=true returns blob bytes when blobRef is set", async () => {
    const bytes = new TextEncoder().encode("weber book text");
    const provider = createCorpusMcpProvider(
      async () => settings,
      () => makePorts({ blobRef: "some/key", blobBytes: bytes }),
    );
    const tools = await provider(COMPANY_ID);
    const view = await tools!.getDocument({ documentId: DOCUMENT_ID, includeText: true });
    expect(view.text).toBe("weber book text");
  });

  it("get_document with include_text=false leaves text null even when blob exists", async () => {
    const provider = createCorpusMcpProvider(
      async () => settings,
      () => makePorts({ blobRef: "some/key", blobBytes: new TextEncoder().encode("x") }),
    );
    const tools = await provider(COMPANY_ID);
    const view = await tools!.getDocument({ documentId: DOCUMENT_ID, includeText: false });
    expect(view.text).toBeNull();
  });
});
