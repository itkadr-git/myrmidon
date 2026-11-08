// server/src/myrmidon/corpus/contract.ts
//
// myrmidon(1.6.6 CORPUS-2.0, part D): the seam between the corpus MCP tools and
// the module they speak for.
//
// The tools in `tools.ts` and the endpoint in `mcp.ts` know nothing about SQL,
// embeddings or the parse queue. They need exactly two things and both are
// injected:
//
//   * `CorpusModuleSettings` — is the module on, and what are the defaults the
//     tools apply when a bot omits an argument. Part C owns the settings block
//     (`instance_settings.general.corpus`, additive) and its validation; this
//     file only *names* the block and the fields part D reads, so that the tool
//     surface and the settings screen are built against one shape.
//   * `CorpusMcpPort` — what a tool asks the corpus for, once, per call. Parts A
//     and B own the implementations behind it (`packages/corpus`: CorpusStore,
//     SearchIndex); part C adapts them to this interface and hands the port to
//     `myrmidonCorpusRoutes` when it mounts the endpoint next to its own routes.
//
// Freezing this file is what lets part D start before A, B and C land: the tool
// names, argument names and result shapes below are the contract, and the parts
// that own the data side adapt to them rather than the other way round. Every
// shape here is deliberately smaller than what the module knows — a tool result
// is read by a bot, not by the board's own code.
//
// Shadow mode (OPE-6166) replays the same request through the RAGFlow facade and
// through these tools, so `corpus_search` accepts the argument names the RAGFlow
// retrieval tool already uses (`dataset_ids`, `top_k`, `similarity_threshold`)
// beside its own (`dataset`, `top_k`, `min_score`). A caller that knows only the
// RAGFlow spelling does not have to be rewritten to be routed here.

/** Path of the company's corpus MCP endpoint, mounted like the OCR one. */
export const CORPUS_MCP_ROUTE = "/myrmidon/companies/:companyId/corpus/mcp";

/** MCP server name a bot sees in `initialize`. */
export const CORPUS_MCP_SERVER_NAME = "myrmidon-corpus";

/**
 * Where the module's switch lives. Part C writes the block; part D reads only
 * `enabled` (and the two defaults below) from it.
 */
export const CORPUS_SETTINGS_BLOCK = "corpus";

/** Default `top_k` when a bot does not ask for one. */
export const DEFAULT_CORPUS_TOP_K = 5;

/** Largest `top_k` the tools accept; a bigger request is refused, not clamped. */
export const MAX_CORPUS_TOP_K = 50;

/** Largest accepted body of a single search query. */
export const MAX_CORPUS_QUERY_CHARS = 2000;

/**
 * The module as far as a tool is concerned. `enabled` is the whole gate: with it
 * false the endpoint lists no tools at all, so a bot of an instance that never
 * turned the module on sees exactly what it saw before the module existed.
 */
export interface CorpusModuleSettings {
  enabled: boolean;
  /** `top_k` used when the call omits it. */
  defaultTopK: number;
  /** Ceiling for `top_k`; also the ceiling for the number of documents listed. */
  maxTopK: number;
}

/** The safe starting point: off, with the pilot's top-k (OPE-5004 used k=5). */
export const DEFAULT_CORPUS_MODULE_SETTINGS: CorpusModuleSettings = {
  enabled: false,
  defaultTopK: DEFAULT_CORPUS_TOP_K,
  maxTopK: MAX_CORPUS_TOP_K,
};

/**
 * One search as the port receives it. The tools have already resolved aliases,
 * defaults and the ceiling, so the port answers a question with no policy left
 * in it.
 */
export interface CorpusSearchRequest {
  /** The query text, trimmed. */
  query: string;
  /** Dataset ids to restrict the search to; empty means every dataset. */
  datasets: string[];
  /** How many chunks to return; already within the settings' ceiling. */
  topK: number;
  /** Drop hits below this score; null keeps everything the index returns. */
  minScore: number | null;
}

/** Where a hit came from: the bot needs the document, not just the chunk. */
export interface CorpusDocumentRef {
  id: string;
  /** Name as the document was uploaded. */
  name: string;
  datasetId: string;
  datasetName: string;
  /** Board-relative link to the document, when the deployment has one. */
  url: string | null;
}

/** One chunk of a search result. */
export interface CorpusChunkHit {
  chunkId: string;
  document: CorpusDocumentRef;
  /** Position of the chunk in the document, so a bot can ask for its neighbours. */
  ordinal: number;
  /** The chunk text as it was indexed. */
  text: string;
  /** RRF-fused score from the hybrid search (higher is closer). */
  score: number;
}

export interface CorpusSearchResult {
  query: string;
  /** Datasets the search was restricted to; empty means all of them. */
  datasets: string[];
  topK: number;
  hits: CorpusChunkHit[];
}

/** One dataset as `corpus_list_datasets` reports it. */
export interface CorpusDatasetSummary {
  id: string;
  name: string;
  /** Documents in the dataset, whatever their parse state. */
  documents: number;
  /** Documents that finished parsing and are searchable. */
  readyDocuments: number;
  chunks: number;
  /** ISO timestamp of the last change to the dataset. */
  updatedAt: string | null;
}

/** What `corpus_get_document` returns. */
export interface CorpusDocumentView {
  document: CorpusDocumentRef & {
    /** Parse state: queued | parsing | embedding | ready | failed (part A's domain). */
    status: string;
    /** Size of the stored original in bytes, when it is known. */
    sizeBytes: number | null;
    chunks: number;
    createdAt: string | null;
    /** Set when the parse failed; the bot reports it instead of retrying blindly. */
    error: string | null;
  };
  /** The document's text, assembled from its chunks; null when not asked for. */
  text: string | null;
}

/** A page of `corpus_list_documents`. */
export interface CorpusDocumentListPage {
  dataset: { id: string; name: string } | null;
  documents: Array<
    Pick<CorpusDocumentView["document"], "id" | "name" | "datasetId" | "status" | "chunks" | "createdAt">
  >;
  /** The filter that produced the page, so a bot can page from here. */
  offset: number;
  limit: number;
}

/**
 * What the corpus answers a tool. Implemented by part C over parts A and B; a
 * missing document or dataset is a `CorpusError` with a stable code, not an
 * empty result — a bot must be able to tell "nothing matched" from "no such
 * dataset".
 */
export interface CorpusMcpPort {
  search(request: CorpusSearchRequest): Promise<CorpusSearchResult>;
  getDocument(request: { documentId: string; includeText: boolean }): Promise<CorpusDocumentView>;
  listDatasets(): Promise<CorpusDatasetSummary[]>;
  listDocuments(request: { datasetId: string | null; offset: number; limit: number }): Promise<CorpusDocumentListPage>;
}

/**
 * What the endpoint needs, and the whole of it: a settings reader and the port.
 * Part C builds it when it mounts the endpoint; `corpus/index.ts` ships the
 * database-backed one, so the mount stays a single line.
 */
export interface CorpusMcpDeps {
  /**
   * The module's settings. Read per call, so switching the module on needs no
   * restart — and it may go to the database, hence the promise.
   */
  settings(): CorpusModuleSettings | Promise<CorpusModuleSettings>;
  /**
   * The company's port, or null while there is nothing behind the tools yet (the
   * module is off, or the data side is not wired in). Resolved per call: an
   * instance that never enabled the module needs no data side to answer
   * `tools/list`.
   */
  port(companyId: string): CorpusMcpPort | null | Promise<CorpusMcpPort | null>;
}

/**
 * How part C hands the tools a data side. `corpus/index.ts` keeps the registry;
 * with nothing registered the tools answer `corpus_unavailable`, which is the
 * honest answer while the module is on but the data side is not there yet.
 */
export type CorpusMcpPortProvider = (
  companyId: string,
) => CorpusMcpPort | null | Promise<CorpusMcpPort | null>;