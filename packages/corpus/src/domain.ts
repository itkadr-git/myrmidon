/**
 * Corpus module domain model: datasets, documents, chunks, parse states.
 *
 * Pure types and invariants only — no database imports, no dialect operators.
 * All SQL/Postgres specifics live behind the ports in `ports.ts` and their
 * implementations in `postgres/` and `local/`.
 */

export const CORPUS_EMBEDDING_DIMENSIONS = 1024;
export const CORPUS_DEFAULT_EMBEDDING_MODEL = "dashscope-text-embedding-v4";
export const CORPUS_DEFAULT_PARSER_VERSION = "v1";

export const CORPUS_PARSE_STATUSES = [
  "queued",
  "parsing",
  "embedding",
  "ready",
  "failed",
] as const;

export type CorpusParseStatus = (typeof CORPUS_PARSE_STATUSES)[number];

export type CorpusDataset = {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  embeddingModel: string;
  embeddingDimensions: number;
  createdAt: Date;
  updatedAt: Date;
};

export type CorpusDocument = {
  id: string;
  companyId: string;
  datasetId: string;
  title: string;
  sourceUri: string | null;
  blobKey: string | null;
  contentType: string | null;
  byteSize: number | null;
  status: CorpusParseStatus;
  parseError: string | null;
  parserVersion: string | null;
  contentHash: string | null;
  parsedAt: Date | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

export type CorpusChunk = {
  id: string;
  companyId: string;
  documentId: string;
  chunkIndex: number;
  content: string;
  embedding: number[] | null;
  tokenCount: number | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
};

export const CORPUS_PARSE_JOB_STATUSES = [
  "pending",
  "running",
  "done",
  "failed",
] as const;

export type CorpusParseJobStatus = (typeof CORPUS_PARSE_JOB_STATUSES)[number];

export type CorpusParseJob = {
  id: string;
  companyId: string;
  documentId: string;
  parserVersion: string;
  status: CorpusParseJobStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  nextAttemptAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
};

export type CorpusModuleSettings = {
  enabled: boolean;
  defaultEmbedderBaseUrl: string | null;
  defaultEmbeddingModel: string;
  defaultParserUrl: string | null;
  defaultParserVersion: string;
  blobStoreRoot: string | null;
  extra: Record<string, unknown>;
};

export const CORPUS_DEFAULT_SETTINGS: CorpusModuleSettings = {
  enabled: false,
  defaultEmbedderBaseUrl: null,
  defaultEmbeddingModel: CORPUS_DEFAULT_EMBEDDING_MODEL,
  defaultParserUrl: null,
  defaultParserVersion: CORPUS_DEFAULT_PARSER_VERSION,
  blobStoreRoot: null,
  extra: {},
};

export function isCorpusParseStatus(value: string): value is CorpusParseStatus {
  return (CORPUS_PARSE_STATUSES as readonly string[]).includes(value);
}

export function isCorpusParseJobStatus(value: string): value is CorpusParseJobStatus {
  return (CORPUS_PARSE_JOB_STATUSES as readonly string[]).includes(value);
}

/**
 * Terminal state of the worker loop for a document:
 * - ready: parsed and embedded successfully;
 * - failed: parse/embedding failed and retries are exhausted.
 */
export function isTerminalParseStatus(status: CorpusParseStatus): boolean {
  return status === "ready" || status === "failed";
}

/**
 * Invariants enforced by the module (implementations must uphold these):
 * - a chunk's embedding, when present, has exactly CORPUS_EMBEDDING_DIMENSIONS
 *   components and all components are finite numbers;
 * - `queued` means a parse job exists or is about to be enqueued;
 * - `parsing`/`embedding` are only set by the worker while a job is running;
 * - a document never moves from `ready`/`failed` back to an in-flight state
 *   without a new parse job (re-parse resets the state through `queued`).
 */
export function assertEmbeddingDimensions(embedding: number[]): void {
  if (embedding.length !== CORPUS_EMBEDDING_DIMENSIONS) {
    throw new Error(
      `corpus: embedding must have ${CORPUS_EMBEDDING_DIMENSIONS} dimensions, got ${embedding.length}`,
    );
  }
  for (const component of embedding) {
    if (!Number.isFinite(component)) {
      throw new Error("corpus: embedding components must be finite numbers");
    }
  }
}

/**
 * Legal document status transitions. The store enforces them on
 * `updateDocumentStatus`; the worker drives documents through this chain:
 * queued -> parsing -> embedding -> ready (or failed from any in-flight state).
 */
const ALLOWED_DOCUMENT_TRANSITIONS: Readonly<Record<CorpusParseStatus, readonly CorpusParseStatus[]>> = {
  queued: ["parsing", "failed", "queued"],
  parsing: ["embedding", "failed", "queued"],
  embedding: ["ready", "failed", "queued"],
  ready: ["queued"],
  failed: ["queued"],
};

export function canTransitionDocumentStatus(
  from: CorpusParseStatus,
  to: CorpusParseStatus,
): boolean {
  return ALLOWED_DOCUMENT_TRANSITIONS[from].includes(to);
}

export function assertDocumentStatusTransition(
  from: CorpusParseStatus,
  to: CorpusParseStatus,
): void {
  if (!canTransitionDocumentStatus(from, to)) {
    throw new Error(`corpus: illegal document status transition ${from} -> ${to}`);
  }
}

/**
 * Backoff for parse-job retries: 5s, 25s, 125s, ... capped at 30 minutes.
 * `attempts` is the number of attempts already made (>= 1 after a failure).
 */
export function parseJobRetryDelayMs(attempts: number): number {
  const base = 5_000;
  const cap = 30 * 60_000;
  const delay = base * 5 ** Math.max(0, attempts - 1);
  return Math.min(delay, cap);
}
