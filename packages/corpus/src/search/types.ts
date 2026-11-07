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

/**
 * Size of the pool of nearest chunks the vector ranking takes from the HNSW index before the
 * dataset and status filters: `clamp(kCandidates * VECTOR_POOL_FACTOR, VECTOR_POOL_MIN, VECTOR_POOL_MAX)`.
 * The pool is cut by company only (chunks carry no dataset), so it has to be several times wider than
 * the candidates the fusion needs for a dataset that holds a part of the company's chunks to still
 * fill the list.
 */
export const VECTOR_POOL_FACTOR = 8;
export const VECTOR_POOL_MIN = 400;
export const VECTOR_POOL_MAX = 2000;

/**
 * Longest query text, in characters, that still adds the `ILIKE '%…%'` substring match to the
 * full-text ranking. The trigram index reads one posting list per trigram of the pattern, so the cost
 * of the match grows with the length of the text, while a long question is almost never a verbatim
 * substring of a chunk — the `tsvector` match already covers it.
 */
export const DEFAULT_ILIKE_MAX_LENGTH = 16;

/**
 * Largest dataset (in embedded chunks) that is ranked exactly, straight away, instead of through the
 * HNSW pool. Reading and sorting the chunks of a dataset this size takes milliseconds to a few tenths
 * of a second, while the HNSW pool of the company costs a second or two on a cold index and, cut
 * by company, hardly holds any chunk of a small dataset.
 */
export const DEFAULT_EXACT_SET_MAX_CHUNKS = 10_000;

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