import { createHash } from "node:crypto";
import type postgres from "postgres";
import { readMigrationFileContent } from "./migration-metadata.js";
import { createUtilitySql, quoteIdentifier } from "./postgres-utility.js";

import {
  DRIZZLE_MIGRATIONS_TABLE,
  discoverMigrationTableSchema,
  getMigrationTableColumnNames,
  inspectMigrations,
  listJournalMigrationEntries,
  listJournalMigrationFiles,
  quoteLiteral,
} from "./migration-inspection.js";

function splitMigrationStatements(content: string): string[] {
  return content
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

function migrationRequiresNonTransactionalExecution(statements: readonly string[]): boolean {
  return statements.some((statement) => /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i.test(
    statement.replace(/^\s*--.*$/gm, "").trim(),
  ));
}

async function orderMigrationsByJournal(migrationFiles: string[]): Promise<string[]> {
  const journalEntries = await listJournalMigrationEntries();
  const orderByFileName = new Map(journalEntries.map((entry) => [entry.fileName, entry.order]));
  return [...migrationFiles].sort((left, right) => {
    const leftOrder = orderByFileName.get(left);
    const rightOrder = orderByFileName.get(right);
    if (leftOrder === undefined && rightOrder === undefined) return left.localeCompare(right);
    if (leftOrder === undefined) return 1;
    if (rightOrder === undefined) return -1;
    if (leftOrder === rightOrder) return left.localeCompare(right);
    return leftOrder - rightOrder;
  });
}

type SqlExecutor = Pick<ReturnType<typeof postgres>, "unsafe">;

async function runInTransaction(sql: SqlExecutor, action: () => Promise<void>): Promise<void> {
  await sql.unsafe("BEGIN");
  try {
    await action();
    await sql.unsafe("COMMIT");
  } catch (error) {
    try {
      await sql.unsafe("ROLLBACK");
    } catch {
      // Ignore rollback failures and surface the original error.
    }
    throw error;
  }
}

async function latestMigrationCreatedAt(
  sql: SqlExecutor,
  qualifiedTable: string,
): Promise<number | null> {
  const rows = await sql.unsafe<{ created_at: string | number | null }[]>(
    `SELECT created_at FROM ${qualifiedTable} ORDER BY created_at DESC NULLS LAST LIMIT 1`,
  );
  const value = Number(rows[0]?.created_at ?? Number.NaN);
  return Number.isFinite(value) ? value : null;
}

function normalizeFolderMillis(value: number | null | undefined): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  return Date.now();
}

async function ensureMigrationJournalTable(
  sql: ReturnType<typeof postgres>,
): Promise<{ migrationTableSchema: string; columnNames: Set<string> }> {
  let migrationTableSchema = await discoverMigrationTableSchema(sql);
  if (!migrationTableSchema) {
    const drizzleSchema = quoteIdentifier("drizzle");
    const migrationTable = quoteIdentifier(DRIZZLE_MIGRATIONS_TABLE);
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${drizzleSchema}`);
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${drizzleSchema}.${migrationTable} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
    );
    migrationTableSchema = (await discoverMigrationTableSchema(sql)) ?? "drizzle";
  }

  const columnNames = await getMigrationTableColumnNames(sql, migrationTableSchema);
  return { migrationTableSchema, columnNames };
}

async function migrationHistoryEntryExists(
  sql: SqlExecutor,
  qualifiedTable: string,
  columnNames: Set<string>,
  migrationFile: string,
  hash: string,
): Promise<boolean> {
  const predicates: string[] = [];
  if (columnNames.has("hash")) predicates.push(`hash = ${quoteLiteral(hash)}`);
  if (columnNames.has("name")) predicates.push(`name = ${quoteLiteral(migrationFile)}`);
  if (predicates.length === 0) return false;

  const rows = await sql.unsafe<{ one: number }[]>(
    `SELECT 1 AS one FROM ${qualifiedTable} WHERE ${predicates.join(" OR ")} LIMIT 1`,
  );
  return rows.length > 0;
}

async function recordMigrationHistoryEntry(
  sql: SqlExecutor,
  qualifiedTable: string,
  columnNames: Set<string>,
  migrationFile: string,
  hash: string,
  folderMillis: number,
): Promise<void> {
  const insertColumns: string[] = [];
  const insertValues: string[] = [];

  if (columnNames.has("hash")) {
    insertColumns.push(quoteIdentifier("hash"));
    insertValues.push(quoteLiteral(hash));
  }
  if (columnNames.has("name")) {
    insertColumns.push(quoteIdentifier("name"));
    insertValues.push(quoteLiteral(migrationFile));
  }
  if (columnNames.has("created_at")) {
    const latestCreatedAt = await latestMigrationCreatedAt(sql, qualifiedTable);
    const createdAt = latestCreatedAt === null
      ? normalizeFolderMillis(folderMillis)
      : Math.max(latestCreatedAt + 1, normalizeFolderMillis(folderMillis));
    insertColumns.push(quoteIdentifier("created_at"));
    insertValues.push(quoteLiteral(String(createdAt)));
  }

  if (insertColumns.length === 0) return;

  await sql.unsafe(
    `INSERT INTO ${qualifiedTable} (${insertColumns.join(", ")}) VALUES (${insertValues.join(", ")})`,
  );
}

async function applyPendingMigrationsManually(
  url: string,
  pendingMigrations: string[],
): Promise<void> {
  if (pendingMigrations.length === 0) return;

  const orderedPendingMigrations = await orderMigrationsByJournal(pendingMigrations);
  const journalEntries = await listJournalMigrationEntries();
  const folderMillisByFileName = new Map(
    journalEntries.map((entry) => [entry.fileName, normalizeFolderMillis(entry.folderMillis)]),
  );

  const sql = await createUtilitySql(url);
  try {
    const { migrationTableSchema, columnNames } = await ensureMigrationJournalTable(sql);
    const qualifiedTable = `${quoteIdentifier(migrationTableSchema)}.${quoteIdentifier(DRIZZLE_MIGRATIONS_TABLE)}`;

    for (const migrationFile of orderedPendingMigrations) {
      const migrationContent = await readMigrationFileContent(migrationFile);
      const hash = createHash("sha256").update(migrationContent).digest("hex");
      const existingEntry = await migrationHistoryEntryExists(
        sql,
        qualifiedTable,
        columnNames,
        migrationFile,
        hash,
      );
      if (existingEntry) continue;

      const statements = splitMigrationStatements(migrationContent);
      const recordHistory = () => recordMigrationHistoryEntry(
        sql,
        qualifiedTable,
        columnNames,
        migrationFile,
        hash,
        folderMillisByFileName.get(migrationFile) ?? Date.now(),
      );
      if (migrationRequiresNonTransactionalExecution(statements)) {
        // PostgreSQL forbids CREATE INDEX CONCURRENTLY in a transaction.
        for (const statement of statements) {
          await sql.unsafe(statement);
        }
        await runInTransaction(sql, recordHistory);
      } else {
        await runInTransaction(sql, async () => {
          for (const statement of statements) await sql.unsafe(statement);
          await recordHistory();
        });
      }
    }
  } finally {
    await sql.end();
  }
}

async function tableExists(
  sql: ReturnType<typeof postgres>,
  tableName: string,
): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ${tableName}
    ) AS exists
  `;
  return rows[0]?.exists ?? false;
}

async function columnExists(
  sql: ReturnType<typeof postgres>,
  tableName: string,
  columnName: string,
): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ${tableName}
        AND column_name = ${columnName}
    ) AS exists
  `;
  return rows[0]?.exists ?? false;
}

async function columnHasDataType(
  sql: ReturnType<typeof postgres>,
  tableName: string,
  columnName: string,
  dataType: string,
): Promise<boolean> {
  const rows = await sql<{ dataType: string; udtName: string }[]>`
    SELECT data_type AS "dataType", udt_name AS "udtName"
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ${tableName}
      AND column_name = ${columnName}
  `;
  const expected = dataType.toLowerCase();
  return rows.some((row) => (
    row.dataType.toLowerCase() === expected || row.udtName.toLowerCase() === expected
  ));
}

async function indexExists(
  sql: ReturnType<typeof postgres>,
  indexName: string,
): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'i'
        AND c.relname = ${indexName}
        AND NOT EXISTS (
          SELECT 1 FROM pg_index i WHERE i.indexrelid = c.oid AND NOT i.indisvalid
        )
    ) AS exists
  `;
  return rows[0]?.exists ?? false;
}

async function constraintExists(
  sql: ReturnType<typeof postgres>,
  constraintName: string,
): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = 'public'
        AND c.conname = ${constraintName}
    ) AS exists
  `;
  return rows[0]?.exists ?? false;
}

async function functionExists(
  sql: ReturnType<typeof postgres>,
  functionName: string,
): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = ${functionName}
    ) AS exists
  `;
  return rows[0]?.exists ?? false;
}

async function triggerExists(
  sql: ReturnType<typeof postgres>,
  triggerName: string,
): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND t.tgname = ${triggerName}
        AND NOT t.tgisinternal
    ) AS exists
  `;
  return rows[0]?.exists ?? false;
}

async function heartbeatEventSequencesAreUnique(
  sql: ReturnType<typeof postgres>,
): Promise<boolean> {
  const rows = await sql<{ unique: boolean }[]>`
    SELECT NOT EXISTS (
      SELECT 1
      FROM heartbeat_run_events
      GROUP BY run_id, seq
      HAVING count(*) > 1
    ) AS unique
  `;
  return rows[0]?.unique ?? false;
}

async function heartbeatNextEventSequencesAreCurrent(
  sql: ReturnType<typeof postgres>,
): Promise<boolean> {
  const rows = await sql<{ current: boolean }[]>`
    SELECT NOT EXISTS (
      SELECT 1
      FROM heartbeat_runs run
      WHERE run.next_event_seq IS DISTINCT FROM COALESCE((
        SELECT max(event.seq) + 1
        FROM heartbeat_run_events event
        WHERE event.run_id = run.id
      ), 1)
    ) AS current
  `;
  return rows[0]?.current ?? false;
}

async function migrationStatementAlreadyApplied(
  sql: ReturnType<typeof postgres>,
  statement: string,
): Promise<boolean> {
  const normalized = statement
    .replace(/^\s*--.*$/gm, "")
    .replace(/\s+/g, " ")
    .trim();

  const createTableMatch = normalized.match(/^CREATE TABLE(?: IF NOT EXISTS)? "([^"]+)"/i);
  if (createTableMatch) {
    return tableExists(sql, createTableMatch[1]);
  }

  const addColumnMatch = normalized.match(
    /^ALTER TABLE "([^"]+)" ADD COLUMN(?: IF NOT EXISTS)? "([^"]+)"/i,
  );
  if (addColumnMatch) {
    return columnExists(sql, addColumnMatch[1], addColumnMatch[2]);
  }

  const alterColumnTypeMatch = normalized.match(
    /^ALTER TABLE "([^"]+)" ALTER COLUMN "([^"]+)" SET DATA TYPE ([A-Za-z0-9_]+)/i,
  );
  if (alterColumnTypeMatch) {
    return columnHasDataType(
      sql,
      alterColumnTypeMatch[1],
      alterColumnTypeMatch[2],
      alterColumnTypeMatch[3],
    );
  }

  const createIndexMatch = normalized.match(/^CREATE (?:UNIQUE )?INDEX(?: CONCURRENTLY)?(?: IF NOT EXISTS)? "([^"]+)"/i);
  if (createIndexMatch) {
    const isValid = await indexExists(sql, createIndexMatch[1]);
    return isValid;
  }

  const addConstraintMatch = normalized.match(/^ALTER TABLE "([^"]+)" ADD CONSTRAINT "([^"]+)"/i);
  if (addConstraintMatch) {
    return constraintExists(sql, addConstraintMatch[2]);
  }

  const createFunctionMatch = normalized.match(
    /^CREATE OR REPLACE FUNCTION "?([A-Za-z_][A-Za-z0-9_]*)"?\s*\(/i,
  );
  if (createFunctionMatch) {
    return functionExists(sql, createFunctionMatch[1]);
  }

  const createTriggerMatch = normalized.match(
    /^CREATE TRIGGER "?([A-Za-z_][A-Za-z0-9_]*)"?/i,
  );
  if (createTriggerMatch) {
    return triggerExists(sql, createTriggerMatch[1]);
  }

  // These native-runner repairs have persistent postconditions. Verify them
  // instead of replaying them when a restored database is missing only the
  // migration-history row.
  if (
    normalized.startsWith("WITH ranked AS (")
    && normalized.includes('UPDATE "heartbeat_run_events" AS event')
  ) {
    return heartbeatEventSequencesAreUnique(sql);
  }
  if (
    normalized.startsWith('UPDATE "heartbeat_runs" AS run')
    && normalized.includes('SET "next_event_seq" = COALESCE')
  ) {
    return heartbeatNextEventSequencesAreCurrent(sql);
  }

  // If we cannot reason about a statement safely, require manual migration.
  return false;
}

async function migrationContentAlreadyApplied(
  sql: ReturnType<typeof postgres>,
  migrationContent: string,
): Promise<boolean> {
  const statements = splitMigrationStatements(migrationContent);
  if (statements.length === 0) return false;

  for (const statement of statements) {
    const applied = await migrationStatementAlreadyApplied(sql, statement);
    if (!applied) return false;
  }

  return true;
}

export type MigrationHistoryReconcileResult = {
  repairedMigrations: string[];
  remainingMigrations: string[];
};

export async function reconcilePendingMigrationHistory(
  url: string,
): Promise<MigrationHistoryReconcileResult> {
  const state = await inspectMigrations(url);
  if (state.status !== "needsMigrations" || state.reason !== "pending-migrations") {
    return { repairedMigrations: [], remainingMigrations: [] };
  }

  const sql = await createUtilitySql(url);
  const repairedMigrations: string[] = [];

  try {
    const journalEntries = await listJournalMigrationEntries();
    const folderMillisByFile = new Map(journalEntries.map((entry) => [entry.fileName, entry.folderMillis]));
    const migrationTableSchema = await discoverMigrationTableSchema(sql);
    if (!migrationTableSchema) {
      return { repairedMigrations, remainingMigrations: state.pendingMigrations };
    }

    const columnNames = await getMigrationTableColumnNames(sql, migrationTableSchema);
    const qualifiedTable = `${quoteIdentifier(migrationTableSchema)}.${quoteIdentifier(DRIZZLE_MIGRATIONS_TABLE)}`;

    for (const migrationFile of state.pendingMigrations) {
      const migrationContent = await readMigrationFileContent(migrationFile);
      const alreadyApplied = await migrationContentAlreadyApplied(sql, migrationContent);
      if (!alreadyApplied) break;

      const hash = createHash("sha256").update(migrationContent).digest("hex");
      const folderMillis = folderMillisByFile.get(migrationFile) ?? Date.now();
      const existingByHash = columnNames.has("hash")
        ? await sql.unsafe<{ created_at: string | number | null }[]>(
            `SELECT created_at FROM ${qualifiedTable} WHERE hash = ${quoteLiteral(hash)} ORDER BY created_at DESC LIMIT 1`,
          )
        : [];
      const existingByName = columnNames.has("name")
        ? await sql.unsafe<{ created_at: string | number | null }[]>(
            `SELECT created_at FROM ${qualifiedTable} WHERE name = ${quoteLiteral(migrationFile)} ORDER BY created_at DESC LIMIT 1`,
          )
        : [];
      if (existingByHash.length > 0 || existingByName.length > 0) {
        if (columnNames.has("created_at")) {
          const existingHashCreatedAt = Number(existingByHash[0]?.created_at ?? -1);
          if (existingByHash.length > 0 && Number.isFinite(existingHashCreatedAt) && existingHashCreatedAt < folderMillis) {
            await sql.unsafe(
              `UPDATE ${qualifiedTable} SET created_at = ${quoteLiteral(String(folderMillis))} WHERE hash = ${quoteLiteral(hash)} AND created_at < ${quoteLiteral(String(folderMillis))}`,
            );
          }

          const existingNameCreatedAt = Number(existingByName[0]?.created_at ?? -1);
          if (existingByName.length > 0 && Number.isFinite(existingNameCreatedAt) && existingNameCreatedAt < folderMillis) {
            await sql.unsafe(
              `UPDATE ${qualifiedTable} SET created_at = ${quoteLiteral(String(folderMillis))} WHERE name = ${quoteLiteral(migrationFile)} AND created_at < ${quoteLiteral(String(folderMillis))}`,
            );
          }
        }

        repairedMigrations.push(migrationFile);
        continue;
      }

      const insertColumns: string[] = [];
      const insertValues: string[] = [];

      if (columnNames.has("hash")) {
        insertColumns.push(quoteIdentifier("hash"));
        insertValues.push(quoteLiteral(hash));
      }
      if (columnNames.has("name")) {
        insertColumns.push(quoteIdentifier("name"));
        insertValues.push(quoteLiteral(migrationFile));
      }
      if (columnNames.has("created_at")) {
        insertColumns.push(quoteIdentifier("created_at"));
        insertValues.push(quoteLiteral(String(folderMillis)));
      }

      if (insertColumns.length === 0) break;

      await sql.unsafe(
        `INSERT INTO ${qualifiedTable} (${insertColumns.join(", ")}) VALUES (${insertValues.join(", ")})`,
      );
      repairedMigrations.push(migrationFile);
    }
  } finally {
    await sql.end();
  }

  const refreshed = await inspectMigrations(url);
  return {
    repairedMigrations,
    remainingMigrations:
      refreshed.status === "needsMigrations" ? refreshed.pendingMigrations : [],
  };
}

export async function applyPendingMigrations(url: string): Promise<void> {
  const initialState = await inspectMigrations(url);
  if (initialState.status === "upToDate") return;

  if (initialState.reason === "no-migration-journal-empty-db") {
    await applyPendingMigrationsManually(url, initialState.pendingMigrations);
    const finalState = await inspectMigrations(url);
    if (finalState.status !== "upToDate") {
      throw new Error(
        `Failed to bootstrap migrations: ${finalState.pendingMigrations.join(", ")}`,
      );
    }
    return;
  }

  if (initialState.reason === "no-migration-journal-non-empty-db") {
    throw new Error(
      "Database has tables but no migration journal; automatic migration is unsafe. Initialize migration history manually.",
    );
  }

  let state = await inspectMigrations(url);
  if (state.status === "upToDate") return;

  const repair = await reconcilePendingMigrationHistory(url);
  if (repair.repairedMigrations.length > 0) {
    state = await inspectMigrations(url);
    if (state.status === "upToDate") return;
  }

  if (state.status !== "needsMigrations" || state.reason !== "pending-migrations") {
    throw new Error("Migrations are still pending after migration-history reconciliation; run inspectMigrations for details.");
  }

  await applyPendingMigrationsManually(url, state.pendingMigrations);

  const finalState = await inspectMigrations(url);
  if (finalState.status !== "upToDate") {
    throw new Error(
      `Failed to apply pending migrations: ${finalState.pendingMigrations.join(", ")}`,
    );
  }
}

export type MigrationBootstrapResult =
  | { migrated: true; reason: "migrated-empty-db"; tableCount: 0 }
  | { migrated: false; reason: "already-migrated"; tableCount: number }
  | { migrated: false; reason: "not-empty-no-migration-journal"; tableCount: number };

export async function migratePostgresIfEmpty(url: string): Promise<MigrationBootstrapResult> {
  const sql = await createUtilitySql(url);

  try {
    const migrationTableSchema = await discoverMigrationTableSchema(sql);

    const tableCountResult = await sql<{ count: number }[]>`
      select count(*)::int as count
      from information_schema.tables
      where table_schema = 'public'
        and table_type = 'BASE TABLE'
    `;

    const tableCount = tableCountResult[0]?.count ?? 0;

    if (migrationTableSchema) {
      return { migrated: false, reason: "already-migrated", tableCount };
    }

    if (tableCount > 0) {
      return { migrated: false, reason: "not-empty-no-migration-journal", tableCount };
    }

    const migrationFiles = await listJournalMigrationFiles();
    await applyPendingMigrationsManually(url, migrationFiles);

    return { migrated: true, reason: "migrated-empty-db", tableCount: 0 };
  } finally {
    await sql.end();
  }
}
