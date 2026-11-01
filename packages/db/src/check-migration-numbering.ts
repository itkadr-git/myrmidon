import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));
const journalPath = fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url));

export type JournalEntry = {
  idx?: number;
  version?: string;
  when?: number;
  tag?: string;
  breakpoints?: boolean;
};

export type JournalFile = {
  entries?: JournalEntry[];
};

export function migrationNumber(value: string): string | null {
  const match = value.match(/^(\d{4})_/);
  return match ? match[1] : null;
}

export function ensureNoDuplicates(values: string[], label: string) {
  const seen = new Map<string, string>();

  for (const value of values) {
    const number = migrationNumber(value);
    if (!number) {
      throw new Error(`${label} entry does not start with a 4-digit migration number: ${value}`);
    }
    const existing = seen.get(number);
    if (existing) {
      throw new Error(`Duplicate migration number ${number} in ${label}: ${existing}, ${value}`);
    }
    seen.set(number, value);
  }
}

export const STRICT_JOURNAL_INDEX_FROM = 180;

export function ensureNoDuplicateIndices(
  entries: Array<{ idx?: number; tag?: string }>,
  label = "migration journal",
  strictFrom = STRICT_JOURNAL_INDEX_FROM,
) {
  const seen = new Map<number, string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.idx === undefined || typeof entry.idx !== "number") {
      throw new Error(`${label} entry ${index} is missing a numeric idx`);
    }
    if (entry.idx < strictFrom) {
      continue;
    }
    const tag = entry.tag ?? `entry ${index}`;
    const existing = seen.get(entry.idx);
    if (existing) {
      throw new Error(
        `Duplicate migration idx ${entry.idx} in ${label}: ${existing}, ${tag}`,
      );
    }
    seen.set(entry.idx, tag);

    if (entry.tag) {
      const numStr = migrationNumber(entry.tag);
      if (numStr !== null && Number(numStr) !== entry.idx) {
        throw new Error(
          `${label} entry ${index} idx (${entry.idx}) does not match tag number (${numStr}) in ${entry.tag}`,
        );
      }
    }
  }
}

export function ensureStrictlyOrdered(values: string[], label: string) {
  const sorted = [...values].sort();
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] !== sorted[index]) {
      throw new Error(
        `${label} are out of order at position ${index}: expected ${sorted[index]}, found ${values[index]}`,
      );
    }
  }
}

export function ensureJournalMatchesFiles(migrationFiles: string[], journalTags: string[]) {
  const journalFiles = journalTags.map((tag) => `${tag}.sql`);

  if (journalFiles.length !== migrationFiles.length) {
    throw new Error(
      `Migration journal/file count mismatch: journal has ${journalFiles.length}, files have ${migrationFiles.length}`,
    );
  }

  for (let index = 0; index < migrationFiles.length; index += 1) {
    const migrationFile = migrationFiles[index];
    const journalFile = journalFiles[index];
    if (migrationFile !== journalFile) {
      throw new Error(
        `Migration journal/file order mismatch at position ${index}: journal has ${journalFile}, files have ${migrationFile}`,
      );
    }
  }
}

export function validateMigrationNumbering(
  migrationFiles: string[],
  journal: JournalFile,
) {
  ensureNoDuplicates(migrationFiles, "migration files");
  ensureStrictlyOrdered(migrationFiles, "migration files");

  const entries = journal.entries ?? [];
  ensureNoDuplicateIndices(entries, "migration journal");

  const journalTags = entries.map((entry, index) => {
    if (typeof entry.tag !== "string" || entry.tag.length === 0) {
      throw new Error(`Migration journal entry ${index} is missing a tag`);
    }
    return entry.tag;
  });

  ensureNoDuplicates(journalTags, "migration journal");
  ensureStrictlyOrdered(journalTags, "migration journal");
  ensureJournalMatchesFiles(migrationFiles, journalTags);
}

export async function main() {
  const migrationFiles = (await readdir(migrationsDir))
    .filter((entry) => entry.endsWith(".sql"))
    .sort();

  const rawJournal = await readFile(journalPath, "utf8");
  const journal = JSON.parse(rawJournal) as JournalFile;

  validateMigrationNumbering(migrationFiles, journal);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
