// server/src/myrmidon/corpus/in-memory-port.test-fixture.ts
//
// A `CorpusMcpPort` in memory, with just enough of a corpus to be honest about
// it: documents are indexed chunk by chunk, a search scores chunks by how many
// of the query's words they carry, and the dataset and document listings are
// built from what was indexed.
//
// It exists so the MCP suite can ask the question the task asks — "does a search
// return results after a test document is indexed?" — over the real endpoint and
// the real tool code, without a database, a parser or an embedder. The
// production port is part C's over parts A and B; this one implements the same
// interface (see `contract.ts`) and nothing else.

import type {
  CorpusChunkHit,
  CorpusDatasetSummary,
  CorpusDocumentListPage,
  CorpusDocumentRef,
  CorpusDocumentView,
  CorpusMcpPort,
  CorpusSearchRequest,
  CorpusSearchResult,
} from "./contract.js";
import { CorpusError } from "./tools.js";

interface StoredChunk {
  id: string;
  ordinal: number;
  text: string;
}

interface StoredDocument {
  id: string;
  name: string;
  datasetId: string;
  datasetName: string;
  status: string;
  sizeBytes: number | null;
  createdAt: string | null;
  error: string | null;
  url: string | null;
  chunks: StoredChunk[];
}

interface StoredDataset {
  id: string;
  name: string;
  updatedAt: string | null;
}

export interface InMemoryCorpus {
  port: CorpusMcpPort;
  /** Adds a dataset; the same id twice keeps the first. */
  addDataset(input: { id: string; name: string }): void;
  /** Indexes a document as its chunks would be after parsing; returns its id. */
  indexDocument(input: {
    id?: string;
    datasetId: string;
    name: string;
    chunks: string[];
    status?: string;
    error?: string | null;
  }): string;
  /** The same corpus, so a test can assert what the tools were asked for. */
  calls: {
    search: CorpusSearchRequest[];
    getDocument: Array<{ documentId: string; includeText: boolean }>;
    listDocuments: Array<{ datasetId: string | null; offset: number; limit: number }>;
  };
}

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1);

export function createInMemoryCorpus(): InMemoryCorpus {
  const datasets = new Map<string, StoredDataset>();
  const documents = new Map<string, StoredDocument>();
  const calls: InMemoryCorpus["calls"] = { search: [], getDocument: [], listDocuments: [] };
  let sequence = 0;

  const ref = (document: StoredDocument): CorpusDocumentRef => ({
    id: document.id,
    name: document.name,
    datasetId: document.datasetId,
    datasetName: document.datasetName,
    url: document.url,
  });

  const port: CorpusMcpPort = {
    async search(request: CorpusSearchRequest): Promise<CorpusSearchResult> {
      calls.search.push(request);
      const terms = new Set(words(request.query));
      const hits: CorpusChunkHit[] = [];
      for (const document of documents.values()) {
        if (request.datasets.length > 0 && !request.datasets.includes(document.datasetId)) continue;
        if (document.status !== "ready") continue;
        for (const chunk of document.chunks) {
          const chunkTerms = words(chunk.text);
          const matches = chunkTerms.filter((term) => terms.has(term)).length;
          if (matches === 0) continue;
          const score = matches / Math.max(terms.size, 1);
          if (request.minScore !== null && score < request.minScore) continue;
          hits.push({
            chunkId: chunk.id,
            document: ref(document),
            ordinal: chunk.ordinal,
            text: chunk.text,
            score,
          });
        }
      }
      hits.sort((left, right) => right.score - left.score || left.chunkId.localeCompare(right.chunkId));
      return {
        query: request.query,
        datasets: request.datasets,
        topK: request.topK,
        hits: hits.slice(0, request.topK),
      };
    },

    async getDocument(request): Promise<CorpusDocumentView> {
      calls.getDocument.push(request);
      const document = documents.get(request.documentId);
      if (!document) {
        throw new CorpusError("document_not_found", `no document ${request.documentId}`);
      }
      return {
        document: {
          ...ref(document),
          status: document.status,
          sizeBytes: document.sizeBytes,
          chunks: document.chunks.length,
          createdAt: document.createdAt,
          error: document.error,
        },
        text: request.includeText ? document.chunks.map((chunk) => chunk.text).join("\n\n") : null,
      };
    },

    async listDatasets(): Promise<CorpusDatasetSummary[]> {
      return [...datasets.values()].map((dataset) => {
        const own = [...documents.values()].filter((document) => document.datasetId === dataset.id);
        return {
          id: dataset.id,
          name: dataset.name,
          documents: own.length,
          readyDocuments: own.filter((document) => document.status === "ready").length,
          chunks: own.reduce((total, document) => total + document.chunks.length, 0),
          updatedAt: dataset.updatedAt,
        };
      });
    },

    async listDocuments(request): Promise<CorpusDocumentListPage> {
      calls.listDocuments.push(request);
      const own = [...documents.values()].filter(
        (document) => request.datasetId === null || document.datasetId === request.datasetId,
      );
      return {
        dataset: request.datasetId
          ? { id: request.datasetId, name: datasets.get(request.datasetId)?.name ?? request.datasetId }
          : null,
        documents: own.slice(request.offset, request.offset + request.limit).map((document) => ({
          id: document.id,
          name: document.name,
          datasetId: document.datasetId,
          status: document.status,
          chunks: document.chunks.length,
          createdAt: document.createdAt,
        })),
        offset: request.offset,
        limit: request.limit,
      };
    },
  };

  return {
    port,
    calls,
    addDataset({ id, name }) {
      if (!datasets.has(id)) datasets.set(id, { id, name, updatedAt: null });
    },
    indexDocument({ id, datasetId, name, chunks, status = "ready", error = null }) {
      const dataset = datasets.get(datasetId);
      if (!dataset) throw new Error(`indexDocument: no dataset ${datasetId}`);
      const documentId = id ?? `doc-${++sequence}`;
      documents.set(documentId, {
        id: documentId,
        name,
        datasetId,
        datasetName: dataset.name,
        status,
        sizeBytes: chunks.join("").length,
        createdAt: "2026-10-08T00:00:00.000Z",
        error,
        url: `/companies/${datasetId}/corpus/documents/${documentId}`,
        chunks: chunks.map((text, ordinal) => ({ id: `${documentId}-c${ordinal}`, ordinal, text })),
      });
      return documentId;
    },
  };
}