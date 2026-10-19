/**
 * Shared database handle type for the corpus store layer.
 *
 * The corpus package depends on @paperclipai/db only for the schema tables;
 * the Db handle itself is any drizzle node-postgres database whose schema
 * includes the corpus tables (in practice: the handle from `createDb`).
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CorpusDb = NodePgDatabase<any>;
