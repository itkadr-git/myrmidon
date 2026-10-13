// myrmidon(CORPUS-2.0): chunking types.
//
// The pilot window: chunks between 300 and 1500 characters with 150 characters of overlap,
// boundaries on line breaks. All three numbers are module settings, so they arrive here as
// options with the pilot values as defaults.

export interface ChunkingOptions {
  /** Shortest chunk the chunker aims for; only the last chunk may be shorter. */
  readonly minChars: number;
  /** Longest chunk; a longer line is split in the middle. */
  readonly maxChars: number;
  /** How far the next window backs up over the previous one, measured on line boundaries. */
  readonly overlapChars: number;
}

export const DEFAULT_CHUNKING_OPTIONS: ChunkingOptions = {
  minChars: 300,
  maxChars: 1500,
  overlapChars: 150,
};

/** How many hex characters of the sha256 digest make up a chunk id. */
export const CHUNK_ID_LENGTH = 32;

export interface TextChunk {
  /** Deterministic id: the same document, ordinal and content always produce the same id. */
  readonly id: string;
  /** Position of the chunk inside the document, starting at zero. */
  readonly ordinal: number;
  /** Exact slice of the document text, without leading or trailing whitespace. */
  readonly content: string;
  /** Offset of the first character of `content` in the document text. */
  readonly startOffset: number;
  /** Offset just past the last character of `content` in the document text. */
  readonly endOffset: number;
}

export interface ChunkDocumentRequest {
  readonly documentId: string;
  readonly text: string;
  readonly chunking?: Partial<ChunkingOptions>;
}

export function resolveChunkingOptions(options?: Partial<ChunkingOptions>): ChunkingOptions {
  const resolved = { ...DEFAULT_CHUNKING_OPTIONS, ...options };
  if (resolved.maxChars < 1) throw new RangeError("chunk maxChars must be at least one character");
  if (resolved.minChars < 1) throw new RangeError("chunk minChars must be at least one character");
  if (resolved.minChars > resolved.maxChars) throw new RangeError("chunk minChars must not exceed maxChars");
  if (resolved.overlapChars < 0) throw new RangeError("chunk overlapChars must not be negative");
  if (resolved.overlapChars >= resolved.maxChars) {
    throw new RangeError("chunk overlapChars must be smaller than maxChars");
  }
  return resolved;
}