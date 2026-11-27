import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const journalUrl = new URL("./migrations/meta/_journal.json", import.meta.url);

type MigrationJournalFile = {
  entries?: Array<{ idx?: number; tag?: string; when?: number }>;
};

export async function readMigrationJournal(): Promise<MigrationJournalFile> {
  return JSON.parse(await readFile(journalUrl, "utf8")) as MigrationJournalFile;
}

export async function readMigrationFileContent(migrationFile: string): Promise<string> {
  return readFile(new URL(`./migrations/${migrationFile}`, import.meta.url), "utf8");
}

export type MigrationChainEntry = { idx: number; tag: string; hash: string; when: number };

/**
 * myrmidon(MIGRATE-A): the migration chain as drizzle records it in the
 * migrations table: journal order, tag, journal millis, and the sha256 of each
 * SQL file. Read-only; used to prove a source database's applied history.
 */
export async function listMigrationChain(): Promise<MigrationChainEntry[]> {
  const parsed = await readMigrationJournal();
  const out: MigrationChainEntry[] = [];
  for (const [position, entry] of (parsed.entries ?? []).entries()) {
    if (typeof entry?.tag !== "string" || typeof entry?.when !== "number") continue;
    const content = await readMigrationFileContent(`${entry.tag}.sql`);
    out.push({
      idx: Number.isInteger(entry.idx) ? Number(entry.idx) : position,
      tag: entry.tag,
      hash: createHash("sha256").update(content).digest("hex"),
      when: entry.when,
    });
  }
  return out;
}

export type MigrationTargetSchema = {
  tables: Set<string>;
  columns: Set<string>;
};

let cachedMigrationTargetSchema: Promise<MigrationTargetSchema> | null = null;

/**
 * myrmidon(MIGRATE-D2): the target schema (tables and columns) known from
 * our migration tree (the newest migration snapshot in meta/).
 */
export async function loadMigrationTargetSchema(): Promise<MigrationTargetSchema> {
  cachedMigrationTargetSchema ??= (async () => {
    const parsed = await readMigrationJournal();
    const entries = parsed.entries ?? [];
    let maxIdx = -1;
    for (const entry of entries) {
      if (typeof entry?.idx === "number" && entry.idx > maxIdx) {
        maxIdx = entry.idx;
      }
    }
    if (maxIdx < 0) throw new Error("migration journal has no entries");
    const file = `${String(maxIdx).padStart(4, "0")}_snapshot.json`;
    const snapshotPath = fileURLToPath(new URL(`./migrations/meta/${file}`, import.meta.url));
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as {
      tables?: Record<string, { name?: string; columns?: Record<string, unknown> }>;
    };
    const tables = new Set<string>();
    const columns = new Set<string>();
    for (const table of Object.values(snapshot.tables ?? {})) {
      if (!table?.name) continue;
      tables.add(table.name);
      for (const col of Object.keys(table.columns ?? {})) {
        columns.add(`${table.name}.${col}`);
      }
    }
    return { tables, columns };
  })();
  return cachedMigrationTargetSchema;
}
