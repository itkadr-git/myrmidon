import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { inspectMigrations } from "@paperclipai/db";
import { verifyPgDumpMigrationChain } from "./myrmidon-migrate-compatibility.js";

type MigrationOptions = {
  sourceUrl?: string;
  sourceDump?: string;
  targetUrl?: string;
  targetDir?: string;
  dryRun?: boolean;
  json?: boolean;
};

type InventoryEntry = { path: string; sizeBytes: number; sha256: string };

const SUPPORTED_COMMON_BASE = "0279_tired_deathstrike";

function requireExactlyOne(options: MigrationOptions): "url" | "dump" {
  const hasUrl = Boolean(options.sourceUrl?.trim());
  const hasDump = Boolean(options.sourceDump?.trim());
  if (hasUrl === hasDump) {
    throw new Error("Exactly one source is required: --source-url or --source-dump.");
  }
  return hasUrl ? "url" : "dump";
}

function requireTarget(options: MigrationOptions): void {
  if (!options.targetUrl?.trim() && !options.targetDir?.trim()) {
    throw new Error("A target is required: --target-url or --target-dir.");
  }
  if (options.targetUrl?.trim() && options.targetDir?.trim()) {
    throw new Error("Choose only one target: --target-url or --target-dir.");
  }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  return hash.digest("hex");
}

async function inventoryDirectory(root: string): Promise<InventoryEntry[]> {
  const entries: InventoryEntry[] = [];
  async function visit(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute);
      const stats = await lstat(absolute);
      if (stats.isSymbolicLink()) {
        throw new Error(`Refusing symlink in source files: ${relative}`);
      }
      if (stats.isDirectory()) {
        await visit(absolute);
      } else if (stats.isFile()) {
        entries.push({ path: relative, sizeBytes: stats.size, sha256: await hashFile(absolute) });
      }
    }
  }
  await visit(root);
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

export async function myrmidonMigrateCommand(options: MigrationOptions): Promise<void> {
  const sourceKind = requireExactlyOne(options);
  requireTarget(options);

  const result: Record<string, unknown> = {
    command: "myrmidon:migrate",
    mode: options.dryRun ? "dry-run" : "preflight",
    source: sourceKind,
    target: options.targetUrl ? "url" : "directory",
    supportedCommonBase: SUPPORTED_COMMON_BASE,
    writesPerformed: false,
    migration: "not-started",
  };

  if (sourceKind === "dump") {
    const dumpPath = path.resolve(options.sourceDump!);
    const stats = await lstat(dumpPath);
    if (!stats.isFile()) throw new Error(`Source dump is not a regular file: ${dumpPath}`);
    const content = await import("node:fs/promises").then(({ readFile }) => readFile(dumpPath, "utf8"));
    const chain = verifyPgDumpMigrationChain(content);
    result.sourceDump = { sizeBytes: stats.size, sha256: await hashFile(dumpPath), migrationChain: chain };
  } else {
    const state = await inspectMigrations(options.sourceUrl!);
    throw new Error(`Source URL migration inspection is not an exact hash-chain proof (status ${state.status}); URL sources are rejected until the database exposes verifiable applied hashes.`);
  }

  if (options.targetDir) {
    const targetPath = path.resolve(options.targetDir);
    try {
      const targetEntries = await readdir(targetPath, { withFileTypes: true });
      if (targetEntries.length > 0) {
        throw new Error(`Refusing non-empty target directory: ${targetPath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    result.targetDirectory = targetPath;
  }

  if (!options.dryRun) {
    throw new Error("Migration execution is intentionally unavailable until the exact journal adapter and rollback protocol are implemented; use --dry-run for a read-only inventory.");
  }

  console.log(JSON.stringify(result, null, 2));
}

export function registerMyrmidonMigrateCommand(program: { command: (name: string) => any }): void {
  program
    .command("myrmidon:migrate")
    .description(`Preflight or dry-run a fail-closed Paperclip to Myrmidon migration (compatible through ${SUPPORTED_COMMON_BASE})`)
    .option("--source-url <url>", "Read-only source PostgreSQL URL")
    .option("--source-dump <path>", "Read-only source pg_dump file")
    .option("--target-url <url>", "Target PostgreSQL URL (never written in preflight/dry-run)")
    .option("--target-dir <path>", "Target file directory; must be empty")
    .option("--dry-run", "Emit the machine-readable inventory without writes")
    .option("--json", "Reserved for compatibility; output is always JSON")
    .action(myrmidonMigrateCommand);
}

export { inventoryDirectory };
