/**
 * Corpus knowledge module: ports, domain model and PostgreSQL implementations.
 *
 * Public surface: domain types/invariants, ports (CorpusStore, SearchIndex,
 * WorkQueue, BlobStore, DocumentParser, Embedder) and the bundled
 * implementations (Postgres store/queue/settings, local-directory blob store).
 * The hybrid SearchIndex, the HTTP DocumentParser client, the sliding-window
 * chunker and the embedding pipeline implement those ports on top of them.
 */
export * from "./domain.js";
export * from "./ports.js";
export { PostgresCorpusStore } from "./postgres/store.js";
export { PostgresWorkQueue } from "./postgres/queue.js";
export { PostgresCorpusSettingsStore } from "./postgres/settings.js";
export { LocalBlobStore } from "./local/blob-store.js";
export { createPostgresSearchIndex } from "./search/hybrid-search-index.js";
export { chunkDocumentText } from "./chunking/chunker.js";
export { createDocumentIngestionPipeline } from "./ingest/embedding-pipeline.js";
export { createDocumentParserClient } from "./parser/document-parser-client.js";
export { createHttpDocumentParser } from "./parser/http-document-parser.js";
