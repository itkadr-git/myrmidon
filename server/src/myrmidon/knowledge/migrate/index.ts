// server/src/myrmidon/knowledge/migrate/index.ts
//
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-6): the plugin transfer tool (`knowledge-migrate`).
// Classify plans the move under the operator's slug map; import writes the plan
// into the K-1 knowledge store. Page content stays inside the process: every
// report is numbers, key names and counts (§5.3).

export { parseFrontmatter, extractHeading, mapFrontmatter, type ParsedFrontmatter, type FrontmatterFields } from "./frontmatter.js";
export {
  MIGRATE_CLASSES,
  DEFAULT_EXPECTED_TOTAL,
  STUB_BYTES,
  classifyPath,
  slugFor,
  slugSegment,
  isControlFile,
  isRawSource,
  type MigrateClass,
  type SeedPlan,
} from "./classify.js";
export {
  MIGRATE_ACTIONS,
  parseSlugMap,
  serializeSlugMap,
  MigrateInputError,
  type MigrateMap,
  type MigratePagePlan,
  type MigrateAction,
  type MigrateCheck,
} from "./map.js";
export { findLinks, rewriteLinks, splitLinkTarget, resolvedPercent, type LinkOccurrence, type LinkRewriteResult } from "./links.js";
export { readSourceTree, parseCatalog, SourceTreeError, type SourceTree, type SourcePage } from "./source.js";
export { buildClassifyReport, classesOf, type ClassifyReport, type ImportReport, type PlannedPage } from "./report.js";
export {
  planMigration,
  runImport,
  readSlugMap,
  seedSlugMap,
  buildLinkResolver,
  type KnowledgeWriter,
  type MigrationPlan,
  type PlanOptions,
  type ImportOptions,
} from "./run.js";
export type { CreateKnowledgeInput, DraftKnowledgeInput, KnowledgeActor } from "../store.js";