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
  loadMigrationTargetSchema,
  type MigrationTargetSchema,
  applyPendingMigrations,
  reconcilePendingMigrationHistory,
  type MigrationState,
  type MigrationHistoryReconcileResult,
  migratePostgresIfEmpty,
  type MigrationBootstrapResult,
  type Db,
} from "./client.js";
export { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "./embedded-postgres-test-timeout.js";
export type {
  EmbeddedPostgresTestDatabase,
  EmbeddedPostgresTestSupport,
} from "./test-embedded-postgres.js";
export async function getEmbeddedPostgresTestSupport() {
  return (await import("./test-embedded-postgres.js")).getEmbeddedPostgresTestSupport();
}
export async function startEmbeddedPostgresTestDatabase(tempDirPrefix: string) {
  return (await import("./test-embedded-postgres.js")).startEmbeddedPostgresTestDatabase(tempDirPrefix);
}
export {
  formatDatabaseBackupResult,
  BackupVerificationError,
  BackupClientVersionError,
  parsePgMajorVersion,
  type BackupRetentionPolicy,
  type RunDatabaseBackupOptions,
  type RunDatabaseBackupResult,
  type RunDatabaseRestoreOptions,
} from "./backup-public.js";
export async function runDatabaseBackup(...args: Parameters<typeof import("./backup-lib.js").runDatabaseBackup>) {
  return (await import("./backup-lib.js")).runDatabaseBackup(...args);
}
export async function runDatabaseRestore(...args: Parameters<typeof import("./backup-lib.js").runDatabaseRestore>) {
  return (await import("./backup-lib.js")).runDatabaseRestore(...args);
}
export async function diagnosePgDumpClient(...args: Parameters<typeof import("./backup-lib.js").diagnosePgDumpClient>) {
  return (await import("./backup-lib.js")).diagnosePgDumpClient(...args);
}
export {
  createEmbeddedPostgresLogBuffer,
  formatEmbeddedPostgresError,
} from "./embedded-postgres-error.js";
export async function ensureLinuxSharedLibraryAliases(libDir: string): Promise<string[]> {
  const native = await import("./embedded-postgres-native.js");
  return native.ensureLinuxSharedLibraryAliases(libDir);
}
export async function prepareEmbeddedPostgresNativeRuntime(): Promise<void> {
  const native = await import("./embedded-postgres-native.js");
  return native.prepareEmbeddedPostgresNativeRuntime();
}
export { loadWithoutEmbeddedPostgresExitHooks } from "./embedded-postgres-lifecycle.js";
export {
  applyReaddress,
  computeRouteType,
  computeTimeoutAt,
  formatApplySummary,
  type ReaddressApplyItem,
  type ReaddressApplyOptions,
  type ReaddressApplyResult,
} from "./readdress-apply.js";
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
