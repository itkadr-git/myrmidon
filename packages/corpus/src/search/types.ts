// myrmidon(CORPUS-2.0): types of the hybrid search index.
//
// The port itself (`SearchIndex`, `CorpusSearchQuery`, `CorpusSearchHit`) is declared in
// `src/ports`; the search package re-exports it and adds the types that only the PostgreSQL
// implementation and the tests need (the pilot knobs and the rows behind a hit).

import type { CorpusSearchHit, CorpusSearchQuery } from "../ports.js";

export type { CorpusSearchHit, CorpusSearchQuery };

/** Default `limit` of a search request when the caller does not set one. */
export const DEFAULT_SEARCH_LIMIT = 5;

/** Default `hnsw.ef_search` for the vector part of the search (pilot value). */
export const DEFAULT_EF_SEARCH = 64;

/** Largest `limit` the search accepts; keeps a caller from streaming a whole dataset. */
export const MAX_SEARCH_LIMIT = 100;

/** The chunk row behind a hit. */
export interface CorpusSearchChunkRef {
  readonly id: string;
  readonly companyId: string;
  readonly datasetId: string;
  readonly documentId: string;
  /** Position of the chunk inside its document, starting at zero. */
  readonly chunkIndex: number;
  readonly content: string;
  readonly tokenCount: number | null;
  readonly metadata: Record<string, unknown>;
}

/** The document row behind a hit. */
export interface CorpusSearchDocumentRef {
  readonly id: string;
  readonly datasetId: string;
  readonly title: string | null;
  readonly sourceUri: string | null;
}

/** Where a hit came from: both ranks are 1-based, and null means "absent from that ranking". */
export interface CorpusSearchHitFusion {
  readonly vectorRank: number | null;
  readonly fullTextRank: number | null;
}

/**
 * A hit as the search index returns it: every field of the port's `CorpusSearchHit` plus the
 * chunk and document rows and the RRF ranks, because callers render the document and the ticket
 * asks the search to return `score`/`chunk`/`document`.
 */
export type CorpusSearchHitDetail = CorpusSearchHit & {
  readonly chunk: CorpusSearchChunkRef;
  readonly document: CorpusSearchDocumentRef;
  readonly fusion: CorpusSearchHitFusion;
};