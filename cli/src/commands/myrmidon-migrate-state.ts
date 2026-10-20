import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export type JournalPhase = "schema" | "data" | "files" | "verify" | "complete";

export type Journal = {
  version: 1;
  runId: string;
  createdAt: string;
  updatedAt: string;
  status: "in-progress" | "failed" | "complete" | "rolled-back";
  sourceFingerprint: string;
  sourceKind: "url" | "dump";
  targetDb: { name: string; oid: string };
  /** Objects that existed in the target before the run; rollback never touches them. */
  baseline: { extensions: string[]; objects: string[] };
  phases: Partial<Record<JournalPhase, string>>;
  /** Files this run intends to write / has written (intent is recorded before copying). */
  /** Rows the migrations themselves seeded in the fresh target (table -> count); replaced by the source rows. */
  seeded?: Record<string, number>;
  ownedFiles: { path: string; sha256: string }[];
  createdDirs: string[];
  lastError?: string;
};

const JOURNAL_FILE = "journal.json";
const LOCK_FILE = "lock";

export function journalPath(stateDir: string): string {
  return path.join(stateDir, JOURNAL_FILE);
}

export async function readJournal(stateDir: string): Promise<Journal | null> {
  try {
    const parsed = JSON.parse(await readFile(journalPath(stateDir), "utf8")) as Journal;
    if (parsed?.version !== 1) throw new Error("Unsupported journal version.");
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeJournal(stateDir: string, journal: Journal): Promise<void> {
  journal.updatedAt = new Date().toISOString();
  const target = journalPath(stateDir);
  const tmp = `${target}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, target);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Exclusive lock in the state directory; a lock of a dead process is taken over. */
export async function acquireLock(stateDir: string): Promise<() => Promise<void>> {
  await mkdir(stateDir, { recursive: true });
  const lockPath = path.join(stateDir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      await handle.close();
      return async () => {
        await rm(lockPath, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let holder = 0;
      try {
        holder = (JSON.parse(await readFile(lockPath, "utf8")) as { pid?: number }).pid ?? 0;
      } catch {
        holder = 0;
      }
      if (holder > 0 && processAlive(holder)) {
        throw new Error("Another myrmidon:migrate run holds the lock for this state directory.");
      }
      await rm(lockPath, { force: true });
    }
  }
  throw new Error("Could not acquire the migration lock.");
}
