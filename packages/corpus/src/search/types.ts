// myrmidon(CORPUS-2.0): types of the hybrid search index.
//
// These types describe the seam between the corpus search implementation and the rest of the
// module. They mirror the `SearchIndex` port of `src/ports`; until that port lands they are
// declared here so the search code, the ingestion pipeline and the tests can be written and
// typechecked on their own. When the port lands, this file keeps only the schema/parameter
// types and the search types are imported from `src/ports`.

import type { FusionParameters } from "./rrf.js";

/** Default `limit` of a search request when the caller does not set one. */
export const DEFAULT_SEARCH_LIMIT = 5;

/** Default `hnsw.ef_search` for the vector part of the search (pilot value). */
export const DEFAULT_EF_SEARCH = 64;

/** Largest `limit` the search accepts; keeps a caller from streaming a whole dataset. */
export const MAX_SEARCH_LIMIT = 100;

export interface CorpusSearchChunk {
  readonly id: string;
  readonly companyId: string;
  readonly datasetId: string;
  readonly documentId: string;
  /** Position of the chunk inside its document, starting at zero. */
  readonly ordinal: number;
  readonly content: string;
}

export interface CorpusSearchDocument {
  readonly id: string;
  readonly datasetId: string;
  readonly title: string | null;
  readonly sourceUri: string | null;
}

export interface CorpusSearchRequest {
  readonly companyId: string;
  readonly datasetId: string;
  /** Text used by the full text ranking; also the input of the embedding on the caller's side. */
  readonly queryText: string;
  /** L2-normalized query embedding, 1024 dimensions. */
  readonly embedding: readonly number[];
  readonly limit?: number;
  readonly fusion?: FusionParameters;
}

/** Where a hit came from: both ranks are 1-based, and null means "absent from that ranking". */
export interface CorpusSearchHitFusion {
  readonly vectorRank: number | null;
  readonly fullTextRank: number | null;
}

export interface CorpusSearchHit {
  /** RRF score of the merged rankings. */
  readonly score: number;
  readonly chunk: CorpusSearchChunk;
  readonly document: CorpusSearchDocument;
  readonly fusion: CorpusSearchHitFusion;
}

export interface CorpusSearchIndex {
  search(request: CorpusSearchRequest): Promise<CorpusSearchHit[]>;
}