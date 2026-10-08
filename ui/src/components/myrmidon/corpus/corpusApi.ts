// myrmidon(1.6.6 CORPUS E): API client for the knowledge corpus screen.
//
// The server half of the module owns the `corpus` block of instance settings
// and the corpus routes. The UI is built in parallel against the frozen
// contract, so everything in this file that describes the wire shape is a LOCAL
// mirror of it. When the server half merges, drop the mirrored interfaces and
// import them from `@paperclipai/shared`; the client functions stay.
//
//   GET  /api/myrmidon/companies/:companyId/corpus/settings
//   PUT  /api/myrmidon/companies/:companyId/corpus/settings   (same body)
//   GET  /api/myrmidon/companies/:companyId/corpus/datasets
//   POST /api/myrmidon/companies/:companyId/corpus/datasets   { name }
//   DELETE /api/myrmidon/companies/:companyId/corpus/datasets/:datasetId
//   GET  /api/myrmidon/companies/:companyId/corpus/datasets/:datasetId/documents
//   POST /api/myrmidon/companies/:companyId/corpus/documents  multipart: datasetId + file
//   POST /api/myrmidon/companies/:companyId/corpus/documents/:documentId/retry
//   DELETE /api/myrmidon/companies/:companyId/corpus/documents/:documentId
//   POST /api/myrmidon/companies/:companyId/corpus/datasets/:datasetId/search
//        { query, topK } -> { hits: [...] }
//
// A disabled module answers 503 (or omits the routes entirely), which the
// container surfaces as "the module is off", not as a failure.
import { api } from "@/api/client";

/** Ceilings the server enforces on the settings block; the form validates first. */
export const CORPUS_MAX_UPLOAD_MB_MIN = 1;
export const CORPUS_MAX_UPLOAD_MB_MAX = 200;
export const CORPUS_MAX_DOCUMENTS_MIN = 1;
export const CORPUS_MAX_DOCUMENTS_MAX = 10000;
export const CORPUS_SEARCH_TOP_K_MIN = 1;
export const CORPUS_SEARCH_TOP_K_MAX = 50;

/** Parse stages a document walks through; `ready` and `failed` are terminal. */
export type CorpusDocumentStatus = "queued" | "parsing" | "embedding" | "ready" | "failed";

/** Sizes the module refuses to exceed — the settings form edits them. */
export interface CorpusLimits {
  /** Largest single upload accepted, in megabytes. */
  maxUploadMb: number;
  /** Documents one dataset may hold. */
  maxDocumentsPerDataset: number;
  /** Chunks a search returns when the query does not ask for a number. */
  searchTopK: number;
}

export interface CorpusSettings {
  /** Module switch: off means no routes, no worker and no parsing. */
  enabled: boolean;
  /**
   * Base URL of the separate document-parsing service. Empty — parsing is not
   * configured, and documents stay in `queued` until it is.
   */
  parsingServiceBaseUrl: string;
  /** Embedder model name used for the vector half of the hybrid index. */
  embedderModel: string;
  limits: CorpusLimits;
}

export interface CorpusDataset {
  id: string;
  name: string;
  documentCount: number;
  createdAt: string;
}

export interface CorpusDocument {
  id: string;
  datasetId: string;
  filename: string;
  status: CorpusDocumentStatus;
  sizeBytes: number;
  chunkCount: number;
  /** Why the parse failed; `null` unless the status is `failed`. */
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One retrieved chunk with its fused rank score. */
export interface CorpusSearchHit {
  documentId: string;
  documentFilename: string;
  chunkIndex: number;
  score: number;
  text: string;
}

export interface CorpusSearchResult {
  datasetId: string;
  query: string;
  hits: CorpusSearchHit[];
  tookMs: number | null;
}

const corpusPath = (companyId: string) =>
  `/myrmidon/companies/${encodeURIComponent(companyId)}/corpus`;

export const corpusSettingsQueryKey = (companyId: string) =>
  ["myrmidon", "corpus", "settings", companyId] as const;

export const corpusDatasetsQueryKey = (companyId: string) =>
  ["myrmidon", "corpus", "datasets", companyId] as const;

export const corpusDocumentsQueryKey = (companyId: string, datasetId: string) =>
  ["myrmidon", "corpus", "documents", companyId, datasetId] as const;

/** Parse stages that still move on their own — a list holding one is polled. */
export const CORPUS_PENDING_STATUSES: CorpusDocumentStatus[] = ["queued", "parsing", "embedding"];

export function hasPendingDocuments(documents: CorpusDocument[] | undefined): boolean {
  if (!documents) return false;
  return documents.some((document) => CORPUS_PENDING_STATUSES.includes(document.status));
}

export const corpusApi = {
  getSettings: (companyId: string) => api.get<CorpusSettings>(`${corpusPath(companyId)}/settings`),
  putSettings: (companyId: string, settings: CorpusSettings) =>
    api.put<CorpusSettings>(`${corpusPath(companyId)}/settings`, settings),

  listDatasets: (companyId: string) => api.get<CorpusDataset[]>(`${corpusPath(companyId)}/datasets`),
  createDataset: (companyId: string, name: string) =>
    api.post<CorpusDataset>(`${corpusPath(companyId)}/datasets`, { name }),
  deleteDataset: (companyId: string, datasetId: string) =>
    api.delete<void>(`${corpusPath(companyId)}/datasets/${encodeURIComponent(datasetId)}`),

  listDocuments: (companyId: string, datasetId: string) =>
    api.get<CorpusDocument[]>(
      `${corpusPath(companyId)}/datasets/${encodeURIComponent(datasetId)}/documents`,
    ),
  uploadDocument: (companyId: string, datasetId: string, file: File) => {
    const body = new FormData();
    body.append("datasetId", datasetId);
    body.append("file", file);
    return api.postForm<CorpusDocument>(`${corpusPath(companyId)}/documents`, body);
  },
  retryDocument: (companyId: string, documentId: string) =>
    api.post<CorpusDocument>(
      `${corpusPath(companyId)}/documents/${encodeURIComponent(documentId)}/retry`,
      {},
    ),
  deleteDocument: (companyId: string, documentId: string) =>
    api.delete<void>(`${corpusPath(companyId)}/documents/${encodeURIComponent(documentId)}`),

  search: (companyId: string, datasetId: string, query: string, topK: number) =>
    api.post<CorpusSearchResult>(
      `${corpusPath(companyId)}/datasets/${encodeURIComponent(datasetId)}/search`,
      { query, topK },
    ),
};