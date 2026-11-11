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
 * Longest query text, in characters, that still adds the `ILIKE '%…%'` substring match to the
 * full-text ranking. The trigram index reads one posting list per trigram of the pattern, so the cost
 * of the match grows with the length of the text, while a long question is almost never a verbatim
 * substring of a chunk — the `tsvector` match already covers it.
 */
export const DEFAULT_ILIKE_MAX_LENGTH = 16;

/**
 * Longest query text that gets the `ILIKE` match whatever `ilikeMaxLength` says, when it is a single
 * token without whitespace. Such a text is an identifier — a file name, a version, a task code — which
 * the `tsvector` match does not find (`litellm_proxy_config` against `litellm_proxy_config.yaml`), while
 * a single token has few trigrams to read and is likely a verbatim substring of a chunk.
 */
export const ILIKE_SINGLE_TOKEN_MAX_LENGTH = 64;

/**
 * Largest dataset (in embedded chunks) that is ranked exactly, straight away, instead of through the
 * HNSW index. Reading and sorting the chunks of a dataset this size takes milliseconds to a few tenths
 * of a second, while the HNSW scan, cut by company only, has to walk a large part of the graph to find
 * a handful of chunks of a small dataset.
 */
export const DEFAULT_EXACT_SET_MAX_CHUNKS = 10_000;

/**
 * `hnsw.max_scan_tuples` of the iterative scan: how many index tuples one search may visit while it
 * looks for enough chunks of the requested dataset. pgvector's own limit is 20 000, and a question
 * that is far from a dataset of 13 % of the corpus (work-craft) stopped there with 47 to 67 of the 100
 * candidates; 100 000 filled the list in every measured case. It is only a cap: a question that is
 * near the dataset stops as soon as the list is full.
 */
export const DEFAULT_MAX_SCAN_TUPLES = 100_000;

/**
 * Longest time, in milliseconds, that the full-text ranking may run: the `statement_timeout` that is set
 * for its own transaction. The ranking scores every chunk that matches the tsquery, and the OR of the
 * significant words of a natural-language question matches a large part of a big corpus. On a corpus of
 * 285 000 chunks the statement averaged 9.8 s and peaked at 104 s, while the vector ranking over the HNSW
 * index takes about 0.4 s. A ranking that is cancelled at the bound leaves the vector ranking to answer
 * alone, so the bound trades a slow, complete answer for a fast one. `0` sets no bound of its own.
 */
export const DEFAULT_FULL_TEXT_TIMEOUT_MS = 800;

/**
 * How many chunks, the best `ts_rank` first, the full-text ranking of a question keeps before it breaks
 * the ties of `ts_rank` with `similarity(content, question)`. `similarity` reads and splits the whole
 * chunk text, so it must not run for every chunk that matches. `ts_rank` has many exact ties (chunks that
 * hold the same words the same number of times), and the pool is wider than the list the fusion takes
 * (`kCandidates`) so that the tie-break still picks among many tied chunks. `0` ranks without a pool.
 */
export const DEFAULT_FULL_TEXT_RERANK_POOL = 1_000;

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