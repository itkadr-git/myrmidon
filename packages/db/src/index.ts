export {
  createDb,
  createPostgresJsClient,
  closeRegisteredClients,
  getPostgresDataDirectory,
  ensurePostgresDatabase,
  resetPostgresDatabase,
  inspectMigrations,
  listMigrationChain,
  type MigrationChainEntry,
  applyPendingMigrations,
  reconcilePendingMigrationHistory,
  type MigrationState,
  type MigrationHistoryReconcileResult,
  migratePostgresIfEmpty,
  type MigrationBootstrapResult,
  type Db,
} from "./client.js";
export {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  type EmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestSupport,
} from "./test-embedded-postgres.js";
export {
  runDatabaseBackup,
  runDatabaseRestore,
  formatDatabaseBackupResult,
  BackupVerificationError,
  BackupClientVersionError,
  parsePgMajorVersion,
  diagnosePgDumpClient,
  type BackupRetentionPolicy,
  type RunDatabaseBackupOptions,
  type RunDatabaseBackupResult,
  type RunDatabaseRestoreOptions,
} from "./backup-lib.js";
export {
  createEmbeddedPostgresLogBuffer,
  formatEmbeddedPostgresError,
} from "./embedded-postgres-error.js";
export {
  ensureLinuxSharedLibraryAliases,
  prepareEmbeddedPostgresNativeRuntime,
} from "./embedded-postgres-native.js";
export { loadWithoutEmbeddedPostgresExitHooks } from "./embedded-postgres-lifecycle.js";
export { issueRelations } from "./schema/issue_relations.js";
export { issueReferenceMentions } from "./schema/issue_reference_mentions.js";
export * from "./schema/index.js";

// myrmidon(1.6.6 KNOWLEDGE-2.0 K-1): pg implementation of the knowledge
// module's SearchIndex port (tsvector + pg_trgm + unaccent on
// `knowledge_search`); the module stays free of dialect SQL by reaching the
// index only through this adapter.
export {
  createPgKnowledgeSearchIndex,
  type KnowledgeSearchIndex,
  type KnowledgeSearchPage,
  type KnowledgeSearchHit,
} from "./knowledge-search.js";
export {
  runContextPersistenceFields,
  runContextWritePatch,
  readRunContextColumnValues,
  heartbeatRunListContextColumnProjections,
  attentionRunIssueTaskColumns,
  HEARTBEAT_RUN_CONTEXT_SUMMARY_MAX_CHARS,
  RUN_CONTEXT_CONTINUATION_KEY,
  type HeartbeatRunContextColumnValues,
} from "./run-context-columns.js";
