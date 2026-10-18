import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir, rmdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import {
  applyPendingMigrations,
  closeRegisteredClients,
  createDb,
  inspectMigrations,
  loadMigrationTargetSchema,
  runDatabaseRestore,
} from "@paperclipai/db";
import { checkVendorChain, chainStartsWithVendor, type ChainCheck } from "./myrmidon-migrate-chain.js";
import {
  buildVendorOnlyIndex,
  loadVendorChain,
  loadVendorOnlyIndex,
  loadVendorReleases,
  type TargetSchemaLookup,
  type VendorOnlyIndex,
} from "./myrmidon-migrate-vendor-chain.js";
import {
  all,
  captureBaseline,
  canUseReplicaRole,
  countFkOrphans,
  countNonEmpty,
  countPublicTables,
  countRows,
  countTextMarkers,
  databaseIdentity,
  dropOwnedObjects,
  insertPage,
  introspectTables,
  jsonbColumns,
  listForeignKeys,
  listForeignSchemaTables,
  normalizeSession,
  orderTables,
  readAppliedChain,
  qi,
  readPage,
  resetSequences,
  rowJson,
  schemaExists,
  selectJsonbCandidates,
  tableDigest,
  textColumns,
  type Q,
  type TableDigest,
  type TableInfo,
} from "./myrmidon-migrate-db.js";
import {
  copyManifest,
  hashFile,
  inventoryDirectory,
  manifestDigest,
  normalizeObjectKey,
  resolveWithin,
  verifyManifest,
  type FileEntry,
} from "./myrmidon-migrate-files.js";
import {
  acquireLock,
  readJournal,
  writeJournal,
  type Journal,
} from "./myrmidon-migrate-state.js";
import {
  assertKeyUsable,
  canDecrypt,
  collectEnvelopes,
  loadKeyMaterial,
  mapCarriers,
  plaintextHash,
  redact,
  rekeyEnvelope,
  sha256Hex,
} from "./myrmidon-migrate-secrets.js";

export { inventoryDirectory } from "./myrmidon-migrate-files.js";

export const MIGRATE_CONTRACT_VERSION = 1;

export type FailureInjection =
  | "after-schema"
  | "mid-data"
  | "after-data-commit"
  | "after-first-file"
  | "after-files";

export type MigrationOptions = {
  sourceUrl?: string;
  sourceUrlEnv?: string;
  sourceDump?: string;
  scratchUrl?: string;
  scratchUrlEnv?: string;
  sourceFiles?: string;
  sourceKeyFile?: string;
  sourceKeyEnv?: string;
  targetUrl?: string;
  targetUrlEnv?: string;
  targetDir?: string;
  targetKeyFile?: string;
  targetKeyEnv?: string;
  stateDir?: string;
  dryRun?: boolean;
  rollback?: boolean;
  allowMissingFiles?: boolean;
  /** Go on when the source holds data of Paperclip features that Myrmidon does not have (it is not transferred). */
  acceptVendorOnlyData?: boolean;
  json?: boolean;
  /** Test seams; not exposed as CLI flags. */
  failureInjection?: FailureInjection;
  env?: NodeJS.ProcessEnv;
};

export type Exclusion = { kind: string; name: string; reason: string };

/**
 * Data of a Paperclip feature that Myrmidon does not have: a table or a column
 * that a later Paperclip release added. `rows` is the number of rows that hold
 * something (for a column: not null and not just its default).
 */
export type VendorOnlyFinding = {
  kind: "table" | "column";
  table: string;
  column?: string;
  rows: number;
  introducedIn: string;
};
export type CarrierColumn = { table: string; column: string; count: number };

export type SourceAnalysis = {
  chain: ChainCheck;
  tables: Map<string, TableInfo>;
  digests: Map<string, TableDigest>;
  carrierColumns: Map<string, string[]>;
  carrierSummary: CarrierColumn[];
  carrierTotal: number;
  carrierPlainDigest: string;
  externalProviderSecrets: { provider: string; count: number }[];
  files: FileEntry[];
  fileProblems: string[];
  localDiskAssets: number;
  externalAssets: number;
  exclusions: Exclusion[];
  /** Per `table.column`: plaintext hashes of the secret carriers found there. */
  plainByColumn: Map<string, string[]>;
  /** Source tables/columns of later Paperclip releases, with the data they hold. */
  vendorOnlyCandidates: VendorOnlyFinding[];
  stateDigest: string;
  fingerprint: string;
};

const PAGE_ROWS = 200;

function resolveUrl(label: string, direct: string | undefined, envName: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  const hasDirect = Boolean(direct?.trim());
  const hasEnv = Boolean(envName?.trim());
  if (hasDirect && hasEnv) throw new Error(`Choose only one ${label} URL input: --${label}-url or --${label}-url-env.`);
  if (hasDirect) return direct!.trim();
  if (hasEnv) {
    const value = env[envName!.trim()]?.trim();
    if (!value) throw new Error(`The environment variable named by --${label}-url-env is not set.`);
    return value;
  }
  return undefined;
}

function secretsOfUrl(url: string | undefined): string[] {
  if (!url) return [];
  const out = [url];
  try {
    const parsed = new URL(url);
    if (parsed.password) out.push(decodeURIComponent(parsed.password), parsed.password);
    if (parsed.username) out.push(decodeURIComponent(parsed.username));
  } catch {
    // not a URL; the raw string is redacted anyway
  }
  return out;
}

async function pathKind(p: string): Promise<"none" | "empty-dir" | "non-empty" | "other"> {
  try {
    const stats = await lstat(p);
    if (stats.isSymbolicLink() || !stats.isDirectory()) return "other";
    return (await readdir(p)).length === 0 ? "empty-dir" : "non-empty";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "none";
    throw error;
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function assertPlainDump(dumpPath: string): Promise<{ sizeBytes: number; sha256: string }> {
  const stats = await lstat(dumpPath);
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error("Source dump is not a regular file.");
  const handle = await open(dumpPath, "r");
  try {
    const head = Buffer.alloc(5);
    await handle.read(head, 0, 5, 0);
    if (head.toString("latin1") === "PGDMP") {
      throw new Error("Custom-format pg_dump archives are not supported; take the dump with `pg_dump --format=plain --no-owner --no-privileges`.");
    }
  } finally {
    await handle.close();
  }
  return { sizeBytes: stats.size, sha256: await hashFile(dumpPath) };
}

class Context {
  readonly options: MigrationOptions;
  readonly env: NodeJS.ProcessEnv;
  readonly secretStrings: string[] = [];
  constructor(options: MigrationOptions) {
    this.options = options;
    this.env = options.env ?? process.env;
  }
  addSecret(value: string | undefined): void {
    if (value) this.secretStrings.push(value);
  }
  redact(text: string): string {
    return redact(text, this.secretStrings);
  }
}

/** Opens a repeatable-read, read-only snapshot of the source database. */
async function withSourceSnapshot<T>(url: string, fn: (q: Q) => Promise<T>): Promise<T> {
  // Pools are closed once, by the caller, after the whole run.
  const db = createDb(url);
  return db.transaction(
    async (tx) => {
      const q = tx as unknown as Q;
      await normalizeSession(q);
      return fn(q);
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

async function inTargetTx<T>(db: ReturnType<typeof createDb>, fn: (q: Q) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    const q = tx as unknown as Q;
    await normalizeSession(q);
    return fn(q);
  });
}

async function tableExists(q: Q, name: string): Promise<boolean> {
  const rows = await all<{ n: number }>(
    q,
    sql`select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name = ${name}`,
  );
  return (rows[0]?.n ?? 0) > 0;
}

async function analyzeSource(
  ctx: Context,
  src: Q,
  keys: { source: string; target: string },
  sourceFilesDir: string | undefined,
  targetSchema?: TargetSchemaLookup,
): Promise<SourceAnalysis> {
  const options = ctx.options;
  const chainRows = await readAppliedChain(src);
  const chain = checkVendorChain(chainRows, await loadVendorReleases());
  if (!chain.supported) {
    throw new Error(`Unsupported source schema (${chain.reason}): ${chain.detail ?? ""}`.trim());
  }

  const tables = await introspectTables(src);
  const exclusions: Exclusion[] = [{ kind: "table", name: "__drizzle_migrations", reason: "migration journal; the target keeps its own" }];
  for (const name of await listForeignSchemaTables(src)) {
    exclusions.push({ kind: "table", name, reason: "outside the public schema; not transferred" });
  }

  const digests = new Map<string, TableDigest>();
  const carrierColumns = new Map<string, string[]>();
  const carrierSummary: CarrierColumn[] = [];
  const plainHashes: string[] = [];
  const plainByColumn = new Map<string, string[]>();
  const vendorIndex = targetSchema
    ? buildVendorOnlyIndex(undefined, targetSchema)
    : await loadVendorOnlyIndex();
  const vendorOnlyCandidates: VendorOnlyFinding[] = [];
  let carrierTotal = 0;
  let undecryptable = 0;

  for (const info of [...tables.values()].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const textMarkers = await countTextMarkers(src, info.name, textColumns(info));
    if (textMarkers > 0) {
      throw new Error(
        `Secret carrier found in a text column of table ${info.name}; it cannot be re-encrypted safely. Refusing to migrate.`,
      );
    }
    const carrierCols: string[] = [];
    for (const column of jsonbColumns(info)) {
      let count = 0;
      for (const candidate of await selectJsonbCandidates(src, info.name, column)) {
        for (const envelope of collectEnvelopes(candidate.v)) {
          count += 1;
          try {
            const hash = await plaintextHash(keys.source, envelope);
            plainHashes.push(hash);
            const key = `${info.name}.${column}`;
            plainByColumn.set(key, [...(plainByColumn.get(key) ?? []), hash]);
          } catch {
            undecryptable += 1;
          }
        }
      }
      if (count > 0) {
        carrierCols.push(column);
        carrierSummary.push({ table: info.name, column, count });
        carrierTotal += count;
      }
    }
    if (carrierCols.length > 0) carrierColumns.set(info.name, carrierCols);
    const digest = await tableDigest(src, info.name, info, new Set(carrierCols));
    digests.set(info.name, digest);

    // Features of later Paperclip releases that this tree does not carry.
    const tableIntroduced = vendorIndex.tables.get(info.name);
    if (tableIntroduced !== undefined) {
      vendorOnlyCandidates.push({ kind: "table", table: info.name, rows: digest.rows, introducedIn: tableIntroduced });
    } else if (digest.rows > 0) {
      for (const col of info.columns) {
        const introduced = vendorIndex.columns.get(`${info.name}.${col.name}`);
        if (introduced === undefined) continue;
        vendorOnlyCandidates.push({
          kind: "column",
          table: info.name,
          column: col.name,
          rows: await countNonEmpty(src, info.name, col),
          introducedIn: introduced,
        });
      }
    }
  }
  if (undecryptable > 0) {
    throw new Error(
      `The source key does not decrypt ${undecryptable} of ${carrierTotal} secret carriers; wrong key or damaged material. Nothing was written.`,
    );
  }
  plainHashes.sort();
  const carrierPlainDigest = sha256Hex(plainHashes.join("\n"));

  let externalProviderSecrets: { provider: string; count: number }[] = [];
  if (tables.has("company_secrets")) {
    externalProviderSecrets = (
      await all<{ provider: string; n: number }>(
        src,
        sql`select provider, count(*)::int as n from company_secrets where provider <> 'local_encrypted' group by provider order by provider`,
      )
    ).map((r) => ({ provider: r.provider, count: r.n }));
  }

  // Files and the assets that point at them.
  let files: FileEntry[] = [];
  const fileProblems: string[] = [];
  let localDiskAssets = 0;
  let externalAssets = 0;
  if (sourceFilesDir) files = await inventoryDirectory(sourceFilesDir);
  if (await tableExists(src, "assets")) {
    const byPath = new Map(files.map((f) => [f.path, f]));
    const assets = await all<{ provider: string; object_key: string; sha256: string }>(
      src,
      sql`select provider, object_key, sha256 from assets order by provider, object_key`,
    );
    for (const asset of assets) {
      if (asset.provider !== "local_disk") {
        externalAssets += 1;
        continue;
      }
      localDiskAssets += 1;
      const key = normalizeObjectKey(asset.object_key);
      if (key === null) {
        fileProblems.push(`invalid-object-key:${asset.object_key}`);
        continue;
      }
      if (!sourceFilesDir) continue;
      const entry = byPath.get(key);
      if (!entry) fileProblems.push(`missing-file:${key}`);
      else if (entry.sha256 !== asset.sha256) fileProblems.push(`hash-mismatch:${key}`);
    }
    if (localDiskAssets > 0 && !sourceFilesDir) {
      fileProblems.push("source-files-not-provided");
    }
  }
  if (externalAssets > 0) {
    exclusions.push({
      kind: "assets",
      name: `${externalAssets} asset row(s) on a non-local provider`,
      reason: "rows are copied; the objects live outside the file tree and are not transferred",
    });
  }
  if (fileProblems.length > 0 && !options.allowMissingFiles) {
    throw new Error(`Source file check failed (${fileProblems.slice(0, 5).join(", ")}${fileProblems.length > 5 ? ", ..." : ""}); use --allow-missing-files only if the loss is acceptable.`);
  }
  if (files.length > 0 && !options.targetDir) {
    throw new Error("--target-dir is required when --source-files holds files.");
  }

  const stateDigest = sourceStateDigest(chainRows!.map((r) => r.hash), digests);
  const fingerprint = sha256Hex(
    JSON.stringify({ state: stateDigest, carriers: carrierPlainDigest, files: manifestDigest(files) }),
  );
  return {
    chain,
    tables,
    digests,
    carrierColumns,
    carrierSummary,
    carrierTotal,
    carrierPlainDigest,
    externalProviderSecrets,
    files,
    fileProblems,
    localDiskAssets,
    externalAssets,
    exclusions,
    plainByColumn,
    vendorOnlyCandidates,
    stateDigest,
    fingerprint,
  };
}

function sourceStateDigest(chainHashes: string[], digests: Map<string, TableDigest>): string {
  const parts = [...digests.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, d]) => `${name}:${d.rows}:${d.digest}`);
  return sha256Hex(`${chainHashes.join(",")}\n${parts.join("\n")}`);
}

/** Cheap re-read of the source to prove it did not change during the run. */
async function recomputeSourceState(src: Q, analysis: SourceAnalysis): Promise<string> {
  const rows = await readAppliedChain(src);
  const digests = new Map<string, TableDigest>();
  const tables = await introspectTables(src);
  for (const info of tables.values()) {
    digests.set(info.name, await tableDigest(src, info.name, info, new Set(analysis.carrierColumns.get(info.name) ?? [])));
  }
  return sourceStateDigest((rows ?? []).map((r) => r.hash), digests);
}

function buildInventory(analysis: SourceAnalysis) {
  const tables = [...analysis.digests.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, d]) => ({
      name,
      rows: d.rows,
      digest: d.digest,
      secretCarrierColumns: analysis.carrierColumns.get(name) ?? [],
    }));
  return {
    tables,
    totals: { tables: tables.length, rows: tables.reduce((n, t) => n + t.rows, 0) },
    secretCarriers: {
      total: analysis.carrierTotal,
      byColumn: analysis.carrierSummary,
      plaintextDigest: analysis.carrierPlainDigest,
      externalProviderSecrets: analysis.externalProviderSecrets,
    },
    files: {
      count: analysis.files.length,
      bytes: analysis.files.reduce((n, f) => n + f.sizeBytes, 0),
      manifestSha256: manifestDigest(analysis.files),
      entries: analysis.files,
      localDiskAssets: analysis.localDiskAssets,
      externalAssets: analysis.externalAssets,
      problems: analysis.fileProblems,
    },
    exclusions: analysis.exclusions,
    sourceFingerprint: analysis.fingerprint,
  };
}

export type CompatResult = { problems: string[]; exclusions: Exclusion[]; vendorOnly: VendorOnlyFinding[] };

/**
 * Compares the source schema with the target. A table or column that only a
 * later Paperclip release has, and the target lacks, is not an error: it is
 * returned in `vendorOnly` (its data is not transferred). Every other mismatch
 * stays a problem.
 */
export function checkCompatibility(
  analysis: Pick<SourceAnalysis, "tables" | "digests" | "vendorOnlyCandidates">,
  target: Map<string, TableInfo>,
  index: VendorOnlyIndex = buildVendorOnlyIndex(),
): CompatResult {
  const problems: string[] = [];
  const exclusions: Exclusion[] = [];
  const vendorOnly: VendorOnlyFinding[] = [];
  const candidateRows = new Map(
    analysis.vendorOnlyCandidates.filter((c) => c.kind === "column").map((c) => [`${c.table}.${c.column}`, c.rows]),
  );
  for (const [name, info] of analysis.tables) {
    const rows = analysis.digests.get(name)?.rows ?? 0;
    const tgt = target.get(name);
    if (!tgt) {
      if (rows > 0) {
        if (index.droppedTables?.has(name)) {
          exclusions.push({ kind: "table", name, reason: "dropped in migration chain; not needed in target" });
          continue;
        }
        const introducedIn = index.tables.get(name);
        if (introducedIn !== undefined) vendorOnly.push({ kind: "table", table: name, rows, introducedIn });
        else problems.push(`table-missing-in-target:${name}`);
      } else exclusions.push({ kind: "table", name, reason: "absent in target and empty in source" });
      continue;
    }
    const tgtCols = new Map(tgt.columns.map((c) => [c.name, c]));
    for (const col of info.columns) {
      if (tgtCols.has(col.name) || rows === 0) continue;
      const key = `${name}.${col.name}`;
      if (index.droppedColumns?.has(key)) {
        exclusions.push({ kind: "column", name: key, reason: "dropped in migration chain; not needed in target" });
        continue;
      }
      const introducedIn = index.columns.get(key);
      if (introducedIn !== undefined) {
        vendorOnly.push({ kind: "column", table: name, column: col.name, rows: candidateRows.get(key) ?? rows, introducedIn });
      } else problems.push(`column-missing-in-target:${key}`);
    }
    if (rows > 0) {
      const srcCols = new Set(info.columns.map((c) => c.name));
      for (const col of tgt.columns) {
        if (!srcCols.has(col.name) && !col.nullable && !col.hasDefault && !col.generated) {
          problems.push(`target-column-requires-value:${name}.${col.name}`);
        }
      }
    }
  }
  return { problems, exclusions, vendorOnly };
}

const INT_RANK: Record<string, number> = { smallint: 1, integer: 2, bigint: 3 };
const INT_RANGE: Record<string, [bigint, bigint]> = {
  smallint: [-32768n, 32767n],
  integer: [-2147483648n, 2147483647n],
};

/**
 * Columns that are wider in the source than in the target (bigint into
 * integer): a value that does not fit is reported before any row is written.
 */
export async function checkNarrowing(
  src: Q,
  analysis: Pick<SourceAnalysis, "tables" | "digests">,
  target: Map<string, TableInfo>,
): Promise<string[]> {
  const problems: string[] = [];
  for (const [name, info] of analysis.tables) {
    if ((analysis.digests.get(name)?.rows ?? 0) === 0) continue;
    const tgt = target.get(name);
    if (!tgt) continue;
    const tgtCols = new Map(tgt.columns.map((c) => [c.name, c]));
    for (const col of info.columns) {
      const tcol = tgtCols.get(col.name);
      if (!tcol) continue;
      const from = INT_RANK[col.dataType];
      const to = INT_RANK[tcol.dataType];
      const range = INT_RANGE[tcol.dataType];
      if (from === undefined || to === undefined || range === undefined || from <= to) continue;
      const rows = await all<{ lo: string | null; hi: string | null }>(
        src,
        sql.raw(`select min(${qi(col.name)})::text as lo, max(${qi(col.name)})::text as hi from ${qi("public")}.${qi(name)}`),
      );
      const lo = rows[0]?.lo;
      const hi = rows[0]?.hi;
      if ((lo != null && BigInt(lo) < range[0]) || (hi != null && BigInt(hi) > range[1])) {
        problems.push(`value-out-of-range-in-target:${name}.${col.name}(source ${col.dataType} ${lo}..${hi}, target ${tcol.dataType})`);
      }
    }
  }
  return problems;
}

/** The analysis as it applies to this target: what the target cannot take is left out of the copy and its checks. */
export async function withoutVendorOnly(
  src: Q,
  analysis: SourceAnalysis,
  found: VendorOnlyFinding[],
  exclusions: Exclusion[] = [],
): Promise<SourceAnalysis> {
  const dropTables = new Set(found.filter((f) => f.kind === "table").map((f) => f.table));
  for (const e of exclusions) {
    if (e.kind === "table") dropTables.add(e.name);
  }
  const dropCols = new Map<string, Set<string>>();
  for (const f of found) {
    if (f.kind === "column") dropCols.set(f.table, (dropCols.get(f.table) ?? new Set()).add(f.column!));
  }
  for (const e of exclusions) {
    if (e.kind === "column") {
      const dot = e.name.indexOf(".");
      if (dot > 0) {
        const table = e.name.slice(0, dot);
        const col = e.name.slice(dot + 1);
        dropCols.set(table, (dropCols.get(table) ?? new Set()).add(col));
      }
    }
  }
  if (dropTables.size === 0 && dropCols.size === 0) return analysis;
  const tables = new Map<string, TableInfo>();
  const digests = new Map<string, TableDigest>();
  for (const [name, info] of analysis.tables) {
    if (dropTables.has(name)) continue;
    const cols = dropCols.get(name);
    if (!cols) {
      tables.set(name, info);
      digests.set(name, analysis.digests.get(name)!);
      continue;
    }
    tables.set(name, { ...info, columns: info.columns.filter((c) => !cols.has(c.name)) });
    digests.set(name, await tableDigest(src, name, info, new Set([...(analysis.carrierColumns.get(name) ?? []), ...cols])));
  }
  const carrierColumns = new Map<string, string[]>();
  for (const [table, cols] of analysis.carrierColumns) {
    if (dropTables.has(table)) continue;
    const kept = cols.filter((c) => !dropCols.get(table)?.has(c));
    if (kept.length > 0) carrierColumns.set(table, kept);
  }
  const carrierSummary = analysis.carrierSummary.filter(
    (c) => !dropTables.has(c.table) && !dropCols.get(c.table)?.has(c.column),
  );
  const plain: string[] = [];
  for (const c of carrierSummary) plain.push(...(analysis.plainByColumn.get(`${c.table}.${c.column}`) ?? []));
  plain.sort();
  return {
    ...analysis,
    tables,
    digests,
    carrierColumns,
    carrierSummary,
    carrierTotal: carrierSummary.reduce((n, c) => n + c.count, 0),
    carrierPlainDigest: sha256Hex(plain.join("\n")),
  };
}

function describeFinding(f: VendorOnlyFinding): string {
  return `${f.table}${f.column ? `.${f.column}` : ""} (${f.rows} row${f.rows === 1 ? "" : "s"}, from ${f.introducedIn})`;
}

/** Stops, before anything is written, when data of features Myrmidon lacks would be left behind without the owner's word. */
export function assertVendorOnlyAccepted(options: MigrationOptions, analysis: SourceAnalysis): void {
  const withData = analysis.vendorOnlyCandidates.filter((c) => c.rows > 0);
  if (withData.length === 0 || options.acceptVendorOnlyData) return;
  const shown = withData.slice(0, 8).map(describeFinding).join(", ");
  throw new Error(
    `The source holds data of Paperclip features that Myrmidon does not have, and that data would not be transferred: ${shown}${withData.length > 8 ? `, and ${withData.length - 8} more` : ""}. ` +
      "Nothing was written. Run with --dry-run to see the full list; to go on without this data, run again with --accept-vendor-only-data.",
  );
}

export function vendorOnlyReport(findings: VendorOnlyFinding[]) {
  const sorted = [...findings].sort((a, b) => `${a.table}.${a.column ?? ""}`.localeCompare(`${b.table}.${b.column ?? ""}`));
  return {
    withData: sorted.filter((f) => f.rows > 0),
    empty: sorted.filter((f) => f.rows === 0),
  };
}

type Target = {
  url: string;
  db: ReturnType<typeof createDb>;
};

type TargetPlan = {
  mode: "fresh" | "resume" | "complete";
  journal: Journal | null;
  identity: { name: string; oid: string };
};

async function planTarget(target: Target, stateDir: string | undefined, targetDir: string | undefined): Promise<TargetPlan> {
  const q = target.db as unknown as Q;
  const identity = await databaseIdentity(q);
  let journal = stateDir ? await readJournal(stateDir) : null;
  if (journal && journal.status === "rolled-back") journal = null;
  if (journal) {
    if (journal.targetDb.oid !== identity.oid) {
      throw new Error("The state directory belongs to a different target database; refusing to continue.");
    }
    return { mode: journal.status === "complete" ? "complete" : "resume", journal, identity };
  }
  const tables = await countPublicTables(q);
  if (tables > 0 || (await schemaExists(q, "drizzle"))) {
    throw new Error("Refusing a non-empty target database that this tool did not create. Use an empty, dedicated database.");
  }
  if (targetDir) {
    const kind = await pathKind(path.resolve(targetDir));
    if (kind === "non-empty" || kind === "other") {
      throw new Error("Refusing a non-empty target directory that this tool did not create.");
    }
  }
  return { mode: "fresh", journal: null, identity };
}

async function restoreDumpToScratch(ctx: Context, dumpPath: string, scratchUrl: string): Promise<void> {
  const db = createDb(scratchUrl);
  try {
    const q = db as unknown as Q;
    const tables = await countPublicTables(q);
    if (tables > 0 || (await schemaExists(q, "drizzle"))) {
      throw new Error("The scratch database is not empty; give --scratch-url an empty throwaway database.");
    }
  } finally {
    await closeRegisteredClients(scratchUrl);
  }
  try {
    await runDatabaseRestore({ connectionString: scratchUrl, backupFile: dumpPath });
  } catch (error) {
    throw new Error(`Restoring the dump into the scratch database failed: ${ctx.redact(error instanceof Error ? error.message : String(error))}`);
  }
}

async function copyTables(
  src: Q,
  tx: Q,
  analysis: SourceAnalysis,
  targetInfo: Map<string, TableInfo>,
  keys: { source: string; target: string },
  injection: FailureInjection | undefined,
  seededTables: string[],
): Promise<{ replicaRole: boolean; sequences: number; replacedSeedTables: string[] }> {
  const fks = await listForeignKeys(tx);
  const names = [...analysis.digests.entries()].filter(([, d]) => d.rows > 0).map(([n]) => n);
  const { order, cyclic, selfReferencing } = orderTables(names, fks);
  const replica = await canUseReplicaRole(tx);
  if (!replica && cyclic.length > 0) {
    throw new Error(
      `Foreign keys form a cycle (${cyclic.slice(0, 5).join(", ")}) and the target role may not set session_replication_role; use a superuser target role for the load.`,
    );
  }
  if (replica) await tx.execute(sql`set local session_replication_role = 'replica'`);
  // Rows the target migrations seeded themselves are replaced by the source rows (the source is the truth).
  for (const name of seededTables) {
    await tx.execute(sql.raw(`delete from ${qi("public")}.${qi(name)}`));
  }

  let copiedTables = 0;
  for (const name of order) {
    const srcInfo = analysis.tables.get(name)!;
    const tgtInfo = targetInfo.get(name)!;
    const srcCols = new Set(srcInfo.columns.map((c) => c.name));
    const insertColumns = tgtInfo.columns.filter((c) => srcCols.has(c.name) && !c.generated);
    const carrierCols = analysis.carrierColumns.get(name) ?? [];
    const limit = !replica && selfReferencing.has(name) ? null : PAGE_ROWS;
    let after: string | null = null;
    for (;;) {
      const page = await readPage(src, name, carrierCols, after, limit);
      if (page.rows.length === 0) break;
      const jsonRows: string[] = [];
      for (const row of page.rows) {
        const carriers: Record<string, unknown> = {};
        for (const [column, value] of Object.entries(row.carriers)) {
          carriers[column] = await mapCarriers(value, (envelope) => rekeyEnvelope(keys.source, keys.target, envelope));
        }
        jsonRows.push(rowJson(row.rest, carriers));
      }
      await insertPage(tx, name, insertColumns, jsonRows);
      after = page.lastRid;
      if (limit === null || page.rows.length < limit) break;
    }
    copiedTables += 1;
    if (injection === "mid-data" && copiedTables === 1) {
      throw new Error("Injected failure in the middle of the data load.");
    }
  }
  const sequences = await resetSequences(tx);
  const orphans = await countFkOrphans(tx, fks);
  if (orphans.length > 0) {
    throw new Error(
      `Foreign key check failed after the load: ${orphans.slice(0, 5).map((o) => `${o.table}/${o.constraint}=${o.orphans}`).join(", ")}.`,
    );
  }
  return { replicaRole: replica, sequences, replacedSeedTables: seededTables };
}

type TableParity = { name: string; sourceRows: number; targetRows: number; match: boolean };

async function compareTables(
  q: Q,
  analysis: SourceAnalysis,
  targetInfo: Map<string, TableInfo>,
): Promise<{ tables: TableParity[]; allMatch: boolean; unexpectedTables: string[] }> {
  const tables: TableParity[] = [];
  for (const [name, d] of [...analysis.digests.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const tgt = targetInfo.get(name);
    if (!tgt) {
      tables.push({ name, sourceRows: d.rows, targetRows: 0, match: d.rows === 0 });
      continue;
    }
    const srcCols = new Set(analysis.tables.get(name)!.columns.map((c) => c.name));
    const exclude = new Set<string>(analysis.carrierColumns.get(name) ?? []);
    for (const col of tgt.columns) if (!srcCols.has(col.name)) exclude.add(col.name);
    const td = await tableDigest(q, name, tgt, exclude);
    tables.push({ name, sourceRows: d.rows, targetRows: td.rows, match: td.rows === d.rows && td.digest === d.digest });
  }
  const unexpectedTables: string[] = [];
  for (const [name] of targetInfo) {
    if (analysis.tables.has(name)) continue;
    if ((await countRows(q, name)) > 0) unexpectedTables.push(name);
  }
  return { tables, allMatch: tables.every((t) => t.match) && unexpectedTables.length === 0, unexpectedTables };
}

async function verifyCarriers(
  q: Q,
  analysis: SourceAnalysis,
  keys: { source: string; target: string },
): Promise<{ total: number; decryptWithTargetKey: boolean; plaintextParity: boolean; oldKeyRejected: boolean | null }> {
  const hashes: string[] = [];
  let total = 0;
  let oldKeyAccepted = 0;
  for (const [table, columns] of analysis.carrierColumns) {
    for (const column of columns) {
      for (const candidate of await selectJsonbCandidates(q, table, column)) {
        for (const envelope of collectEnvelopes(candidate.v)) {
          total += 1;
          try {
            hashes.push(await plaintextHash(keys.target, envelope));
          } catch {
            return { total, decryptWithTargetKey: false, plaintextParity: false, oldKeyRejected: null };
          }
          if (keys.source !== keys.target && (await canDecrypt(keys.source, envelope))) oldKeyAccepted += 1;
        }
      }
    }
  }
  hashes.sort();
  return {
    total,
    decryptWithTargetKey: true,
    plaintextParity: total === analysis.carrierTotal && sha256Hex(hashes.join("\n")) === analysis.carrierPlainDigest,
    oldKeyRejected: keys.source === keys.target ? null : oldKeyAccepted === 0,
  };
}

function relativeDirs(entries: FileEntry[]): string[] {
  const dirs = new Set<string>();
  for (const entry of entries) {
    const parts = entry.path.split("/");
    for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join("/"));
  }
  return [...dirs].sort();
}

export type MigrationResult = Record<string, unknown>;

export async function runMigration(options: MigrationOptions): Promise<MigrationResult> {
  const ctx = new Context(options);
  const env = ctx.env;
  const sourceUrl = resolveUrl("source", options.sourceUrl, options.sourceUrlEnv, env);
  const targetUrl = resolveUrl("target", options.targetUrl, options.targetUrlEnv, env);
  const scratchUrl = resolveUrl("scratch", options.scratchUrl, options.scratchUrlEnv, env);
  for (const url of [sourceUrl, targetUrl, scratchUrl]) for (const s of secretsOfUrl(url)) ctx.addSecret(s);
  try {
    return await execute(ctx, { sourceUrl, targetUrl, scratchUrl });
  } catch (error) {
    const message = ctx.redact(error instanceof Error ? error.message : String(error));
    throw new Error(message);
  }
}

async function execute(
  ctx: Context,
  urls: { sourceUrl?: string; targetUrl?: string; scratchUrl?: string },
): Promise<MigrationResult> {
  const options = ctx.options;
  const { sourceUrl, targetUrl, scratchUrl } = urls;

  if (!targetUrl) throw new Error("A target is required: --target-url or --target-url-env.");
  if (options.rollback) return rollbackRun(ctx, targetUrl);

  const hasUrl = Boolean(sourceUrl);
  const hasDump = Boolean(options.sourceDump?.trim());
  if (hasUrl === hasDump) {
    throw new Error("Exactly one source is required: --source-url (or --source-url-env) or --source-dump.");
  }
  if (hasDump && !scratchUrl) {
    throw new Error("--source-dump needs --scratch-url (or --scratch-url-env): an empty throwaway database the dump is restored into.");
  }
  if (hasUrl && scratchUrl) throw new Error("--scratch-url is only used with --source-dump.");
  if (!options.dryRun && !options.stateDir?.trim()) {
    throw new Error("--state-dir is required for a migration (journal and lock live there).");
  }
  const stateDir = options.stateDir?.trim() ? path.resolve(options.stateDir.trim()) : undefined;
  const targetDir = options.targetDir?.trim() ? path.resolve(options.targetDir.trim()) : undefined;
  const sourceFilesDir = options.sourceFiles?.trim() ? path.resolve(options.sourceFiles.trim()) : undefined;
  if (stateDir && targetDir && isInside(targetDir, stateDir)) {
    throw new Error("--state-dir must be outside --target-dir.");
  }
  if (sourceFilesDir && targetDir && (isInside(sourceFilesDir, targetDir) || isInside(targetDir, sourceFilesDir))) {
    throw new Error("--source-files and --target-dir must be separate directories.");
  }

  // Keys: read and validated before anything else is touched.
  const sourceKey = await loadKeyMaterial("source", { file: options.sourceKeyFile, env: options.sourceKeyEnv }, ctx.env);
  const targetKey = await loadKeyMaterial("target", { file: options.targetKeyFile, env: options.targetKeyEnv }, ctx.env);
  ctx.addSecret(sourceKey);
  ctx.addSecret(targetKey);
  await assertKeyUsable("source", sourceKey);
  await assertKeyUsable("target", targetKey);
  const keys = { source: sourceKey, target: targetKey };

  // Source: URL, or a dump restored into a throwaway database.
  let dumpInfo: { sizeBytes: number; sha256: string } | null = null;
  let dumpPath: string | null = null;
  let readUrl: string;
  if (hasDump) {
    dumpPath = path.resolve(options.sourceDump!.trim());
    dumpInfo = await assertPlainDump(dumpPath);
    await restoreDumpToScratch(ctx, dumpPath, scratchUrl!);
    readUrl = scratchUrl!;
  } else {
    readUrl = sourceUrl!;
  }

  const target: Target = { url: targetUrl, db: createDb(targetUrl) };
  try {
    return await withSourceSnapshot(readUrl, async (src) => {
      const targetSchema = await loadMigrationTargetSchema();
      const analysis = await analyzeSource(ctx, src, keys, sourceFilesDir, targetSchema);
      const inventory = buildInventory(analysis);
      const plan = await planTarget(target, stateDir, targetDir);
      if (plan.journal && plan.journal.sourceFingerprint !== analysis.fingerprint) {
        throw new Error("The source differs from the one this target was started from; roll back (--rollback) before migrating another source.");
      }
      const base = {
        command: "myrmidon:migrate",
        contractVersion: MIGRATE_CONTRACT_VERSION,
        source: {
          kind: hasDump ? "dump" : "url",
          ...(dumpInfo ? { dump: { fileName: path.basename(dumpPath!), ...dumpInfo } } : {}),
          vendorRelease: analysis.chain.vendorRelease,
          chain: { expected: analysis.chain.expected, applied: analysis.chain.applied, matches: true },
        },
        inventory,
        target: { state: plan.mode, database: plan.identity.name },
      };

      if (options.dryRun) {
        const candidates = vendorOnlyReport(analysis.vendorOnlyCandidates);
        return {
          ...base,
          vendorOnlyData: {
            // Pre-checked against our target schema from the migration tree; only truly vendor-only features require the flag.
            requiresFlag: candidates.withData.length > 0,
            flag: "--accept-vendor-only-data",
            ...candidates,
          },
          mode: "dry-run",
          status: "ok",
          writesPerformed: false,
        };
      }
      return realRun(ctx, {
        analysis, inventory, plan, base, src, target, keys, stateDir: stateDir!, targetDir, sourceFilesDir, readUrl, dumpPath, dumpInfo,
      });
    });
  } finally {
    await closeRegisteredClients(targetUrl);
    await closeRegisteredClients(readUrl);
  }
}

type RealRunInput = {
  analysis: SourceAnalysis;
  inventory: ReturnType<typeof buildInventory>;
  plan: TargetPlan;
  base: Record<string, unknown>;
  src: Q;
  target: Target;
  keys: { source: string; target: string };
  stateDir: string;
  targetDir: string | undefined;
  sourceFilesDir: string | undefined;
  readUrl: string;
  dumpPath: string | null;
  dumpInfo: { sizeBytes: number; sha256: string } | null;
};

async function realRun(ctx: Context, input: RealRunInput): Promise<MigrationResult> {
  const { analysis, plan, src, target, keys, stateDir, targetDir } = input;
  if (plan.mode !== "complete") assertVendorOnlyAccepted(ctx.options, analysis);
  const injection = ctx.options.failureInjection;
  const tq = target.db as unknown as Q;
  const release = await acquireLock(stateDir);
  let journal: Journal | null = plan.journal;
  const now = () => new Date().toISOString();
  try {
    if (plan.mode !== "complete") {
      if (!journal) {
        journal = {
          version: 1,
          runId: createHash("sha256").update(`${Date.now()}:${Math.random()}`).digest("hex").slice(0, 16),
          createdAt: now(),
          updatedAt: now(),
          status: "in-progress",
          sourceFingerprint: analysis.fingerprint,
          sourceKind: input.dumpPath ? "dump" : "url",
          targetDb: plan.identity,
          baseline: await captureBaseline(tq),
          phases: {},
          ownedFiles: [],
          createdDirs: [],
        };
        await writeJournal(stateDir, journal);
      } else {
        journal.status = "in-progress";
        delete journal.lastError;
        await writeJournal(stateDir, journal);
      }
    }

    const phases: string[] = [];
    let copyInfo: { replicaRole: boolean; sequences: number; replacedSeedTables: string[] } | null = null;

    if (plan.mode !== "complete") {
      // 1. schema: the target gets the Myrmidon migration chain.
      await applyPendingMigrations(target.url);
      const targetState = await inspectMigrations(target.url);
      if (targetState.status !== "upToDate") throw new Error("Target migrations are not up to date after applying them.");
      const targetChain = await readAppliedChain(tq);
      if (!targetChain || !chainStartsWithVendor(targetChain, await loadVendorChain())) {
        throw new Error("The target migration chain does not contain the vendor chain as its exact prefix; refusing to load data.");
      }
      if (!journal!.phases.schema) {
        const fresh = await introspectTables(tq);
        const seeded: Record<string, number> = {};
        for (const name of fresh.keys()) {
          const n = await countRows(tq, name);
          if (n > 0) seeded[name] = n;
        }
        journal!.seeded = seeded;
        journal!.phases.schema = now();
        await writeJournal(stateDir, journal!);
      }
      phases.push("schema");
      if (injection === "after-schema") throw new Error("Injected failure after the schema phase.");
    }

    const targetInfo = await introspectTables(tq);
    const vendorIndex = await loadVendorOnlyIndex();
    const compat = checkCompatibility(analysis, targetInfo, vendorIndex);
    const narrowing = compat.problems.length === 0 ? await checkNarrowing(src, analysis, targetInfo) : [];
    const problems = [...compat.problems, ...narrowing];
    if (problems.length > 0) {
      throw new Error(`Target schema cannot take the source data: ${problems.slice(0, 8).join(", ")}${problems.length > 8 ? ", ..." : ""}. Roll back (--rollback) the schema and report this.`);
    }
    // What the target cannot take stays out of the copy and out of the checks below.
    const eff = await withoutVendorOnly(src, analysis, compat.vendorOnly, compat.exclusions);

    if (plan.mode !== "complete") {
      // 2. data: one transaction; either all rows land or none.
      if (!journal!.phases.data) {
        const seededNames = new Set(Object.keys(journal!.seeded ?? {}));
        let targetHasRows = false;
        for (const name of targetInfo.keys()) {
          if (seededNames.has(name)) continue;
          if ((await countRows(tq, name)) > 0) {
            targetHasRows = true;
            break;
          }
        }
        if (targetHasRows) {
          const existing = await inTargetTx(target.db, (q) => compareTables(q, eff, targetInfo));
          if (!existing.allMatch) {
            const bad = existing.tables.filter((t) => !t.match).map((t) => `${t.name}(${t.sourceRows}/${t.targetRows})`);
            throw new Error(`The target holds data that does not match the source (an interrupted or foreign load; source/target rows: ${bad.concat(existing.unexpectedTables.map((t) => `${t}(unexpected)`)).slice(0, 12).join(", ")}); run --rollback and start again.`);
          }
          // A previous run committed the data and died before writing the journal.
        } else {
          copyInfo = await target.db.transaction(async (tx) => {
            const q = tx as unknown as Q;
            await normalizeSession(q);
            return copyTables(src, q, eff, targetInfo, keys, injection, [...seededNames]);
          });
        }
        if (injection === "after-data-commit") throw new Error("Injected failure after the data commit.");
        journal!.phases.data = now();
        await writeJournal(stateDir, journal!);
      }
      phases.push("data");

      // 3. files: intent first, then copy with per-file hash checks.
      if (!journal!.phases.files) {
        if (input.analysis.files.length > 0) {
          const dirs = relativeDirs(input.analysis.files);
          const knownDirs = new Set(journal!.createdDirs);
          for (const dir of dirs) {
            const absolute = resolveWithin(targetDir!, dir);
            try {
              await lstat(absolute);
            } catch {
              knownDirs.add(dir);
            }
          }
          journal!.createdDirs = [...knownDirs].sort();
          journal!.ownedFiles = input.analysis.files.map((f) => ({ path: f.path, sha256: f.sha256 }));
          await writeJournal(stateDir, journal!);
          await mkdir(targetDir!, { recursive: true });
          await copyManifest(input.sourceFilesDir!, targetDir!, input.analysis.files, {
            afterFile: (index) => {
              if (injection === "after-first-file" && index === 0) throw new Error("Injected failure after the first file.");
            },
          });
        }
        if (injection === "after-files") throw new Error("Injected failure after the files phase.");
        journal!.phases.files = now();
        await writeJournal(stateDir, journal!);
      }
      phases.push("files");
    }

    // 4. verification: facts, not the absence of errors.
    const verification = await inTargetTx(target.db, async (vq) => {
      const parity = await compareTables(vq, eff, targetInfo);
      const fkProblems = await countFkOrphans(vq, await listForeignKeys(vq));
      const carriers = await verifyCarriers(vq, eff, keys);
      return { parity, fkProblems, carriers };
    });
    const fileProblems = input.analysis.files.length > 0 ? await verifyManifest(targetDir!, input.analysis.files) : [];
    let sourceUnchanged = await withSourceSnapshot(input.readUrl, (s2) => recomputeSourceState(s2, analysis)) === analysis.stateDigest;
    if (input.dumpInfo) {
      sourceUnchanged = sourceUnchanged && (await hashFile(input.dumpPath!)) === input.dumpInfo.sha256;
    }
    const { parity, fkProblems, carriers } = verification;
    const report = {
      tables: parity.tables,
      unexpectedTargetTables: parity.unexpectedTables,
      countsAndContentMatch: parity.allMatch,
      foreignKeyViolations: fkProblems,
      secrets: carriers,
      filesVerified: input.analysis.files.length,
      fileProblems,
      sourceUnchanged,
    };
    const ok =
      parity.allMatch &&
      fkProblems.length === 0 &&
      carriers.decryptWithTargetKey &&
      carriers.plaintextParity &&
      carriers.oldKeyRejected !== false &&
      fileProblems.length === 0 &&
      sourceUnchanged;
    if (!ok) {
      throw new Error(`Verification failed: ${JSON.stringify({ ...report, tables: parity.tables.filter((t) => !t.match) })}`);
    }
    if (plan.mode !== "complete") {
      journal!.phases.verify = now();
      journal!.phases.complete = now();
      journal!.status = "complete";
      await writeJournal(stateDir, journal!);
      phases.push("verify", "complete");
    }

    const result: MigrationResult = {
      ...input.base,
      mode: "migrate",
      status: plan.mode === "complete" ? "already-migrated" : "ok",
      writesPerformed: plan.mode !== "complete",
      phases,
      load: copyInfo,
      verification: report,
      vendorOnlyData: { acceptedByFlag: Boolean(ctx.options.acceptVendorOnlyData), transferred: false, ...vendorOnlyReport(compat.vendorOnly) },
      stateDir,
    };
    await writeFile(path.join(stateDir, "report.json"), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    return result;
  } catch (error) {
    if (journal && plan.mode !== "complete") {
      journal.status = "failed";
      journal.lastError = ctx.redact(error instanceof Error ? error.message : String(error)).slice(0, 2000);
      try {
        await writeJournal(stateDir, journal);
      } catch {
        // keep the original error
      }
    }
    throw error;
  } finally {
    await release();
  }
}

async function rollbackRun(ctx: Context, targetUrl: string): Promise<MigrationResult> {
  const options = ctx.options;
  const stateDir = options.stateDir?.trim() ? path.resolve(options.stateDir.trim()) : undefined;
  if (!stateDir) throw new Error("--state-dir is required for --rollback.");
  const journal = await readJournal(stateDir);
  if (!journal) throw new Error("No journal in the state directory: nothing this tool created, nothing to roll back.");
  if (journal.status === "rolled-back") {
    return { command: "myrmidon:migrate", contractVersion: MIGRATE_CONTRACT_VERSION, mode: "rollback", status: "already-rolled-back", writesPerformed: false };
  }
  const targetDir = options.targetDir?.trim() ? path.resolve(options.targetDir.trim()) : undefined;
  if (journal.ownedFiles.length > 0 && !targetDir) {
    throw new Error("--target-dir is required to roll back the copied files.");
  }
  const release = await acquireLock(stateDir);
  const db = createDb(targetUrl);
  try {
    const q = db as unknown as Q;
    const identity = await databaseIdentity(q);
    if (identity.oid !== journal.targetDb.oid) {
      throw new Error("The journal belongs to a different target database; refusing to roll back.");
    }
    await db.transaction(async (tx) => {
      await dropOwnedObjects(tx as unknown as Q, journal.baseline);
    });
    const kept: string[] = [];
    let removedFiles = 0;
    if (targetDir) {
      for (const owned of journal.ownedFiles) {
        const absolute = resolveWithin(targetDir, owned.path);
        await rm(`${absolute}.migrate-tmp`, { force: true });
        let present = true;
        try {
          await lstat(absolute);
        } catch {
          present = false;
        }
        if (!present) continue;
        if ((await hashFile(absolute)) === owned.sha256) {
          await rm(absolute, { force: true });
          removedFiles += 1;
        } else {
          kept.push(owned.path);
        }
      }
      for (const dir of [...journal.createdDirs].sort().reverse()) {
        try {
          await rmdir(resolveWithin(targetDir, dir));
        } catch {
          // not empty or already gone: leave it
        }
      }
    }
    journal.status = "rolled-back";
    await writeJournal(stateDir, journal);
    return {
      command: "myrmidon:migrate",
      contractVersion: MIGRATE_CONTRACT_VERSION,
      mode: "rollback",
      status: "rolled-back",
      writesPerformed: true,
      removedFiles,
      filesKeptBecauseChanged: kept,
    };
  } finally {
    await closeRegisteredClients(targetUrl);
    await release();
  }
}

export async function myrmidonMigrateCommand(options: MigrationOptions): Promise<void> {
  const result = await runMigration(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export function registerMyrmidonMigrateCommand(program: { command: (name: string) => any }): void {
  program
    .command("myrmidon:migrate")
    .description("Transfer a Paperclip instance of a supported release (see the migration guide for the list) (DB + files + secrets) into a clean Myrmidon target; fail-closed")
    .option("--source-url <url>", "Source Paperclip PostgreSQL URL (read-only)")
    .option("--source-url-env <name>", "Name of an environment variable holding the source URL")
    .option("--source-dump <path>", "Source pg_dump file (plain format); restored into --scratch-url")
    .option("--scratch-url <url>", "Empty throwaway database for restoring --source-dump")
    .option("--scratch-url-env <name>", "Name of an environment variable holding the scratch URL")
    .option("--source-files <dir>", "Source storage directory (local_disk assets)")
    .option("--source-key-file <path>", "File holding the source secrets master key")
    .option("--source-key-env <name>", "Environment variable holding the source secrets master key")
    .option("--target-url <url>", "Target PostgreSQL URL (empty dedicated database)")
    .option("--target-url-env <name>", "Name of an environment variable holding the target URL")
    .option("--target-dir <dir>", "Target storage directory for files (must be empty or absent)")
    .option("--target-key-file <path>", "File holding the target secrets master key")
    .option("--target-key-env <name>", "Environment variable holding the target secrets master key")
    .option("--state-dir <dir>", "Directory for the journal, lock and report (required unless --dry-run)")
    .option("--dry-run", "Print the full inventory without writing anything to the target")
    .option("--rollback", "Remove what an earlier run created in the target (owned objects and files only)")
    .option(
      "--accept-vendor-only-data",
      "Continue when the source holds data of Paperclip features Myrmidon does not have (it is listed and not transferred)",
    )
    .option("--allow-missing-files", "Continue when asset files are missing or differ (they are reported)")
    .option("--json", "Accepted for compatibility; output is always JSON")
    .action(myrmidonMigrateCommand);
}
