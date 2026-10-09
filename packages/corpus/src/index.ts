/**
 * Corpus knowledge module: ports, domain model and PostgreSQL implementations.
 *
 * Public surface: domain types/invariants, ports (CorpusStore, SearchIndex,
 * WorkQueue, BlobStore, DocumentParser, Embedder) and the bundled
 * implementations (Postgres store/queue/settings, local-directory blob store).
 * The hybrid SearchIndex and the HTTP DocumentParser client ship in a later
 * part on top of these ports.
 */
export * from "./domain.js";
export * from "./ports.js";
export { PostgresCorpusStore } from "./postgres/store.js";
export { PostgresWorkQueue } from "./postgres/queue.js";
export { PostgresCorpusSettingsStore } from "./postgres/settings.js";
export { LocalBlobStore } from "./local/blob-store.js";
