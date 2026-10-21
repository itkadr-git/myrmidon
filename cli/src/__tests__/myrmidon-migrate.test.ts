import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import {
  closeRegisteredClients,
  createDb,
  ensurePostgresDatabase,
  loadMigrationTargetSchema,
  runDatabaseBackup,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  type EmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { checkVendorChain, chainStartsWithVendor } from "../commands/myrmidon-migrate-chain.js";
import {
  buildVendorOnlyIndex,
  loadVendorChain,
  loadVendorReleases,
  type VendorOnlyIndex,
  type VendorRelease,
} from "../commands/myrmidon-migrate-vendor-chain.js";
import type { ColumnInfo, TableInfo } from "../commands/myrmidon-migrate-db.js";
import {
  copyManifest,
  inventoryDirectory,
  normalizeObjectKey,
  resolveWithin,
} from "../commands/myrmidon-migrate-files.js";
import {
  collectEnvelopes,
  countCarriers,
  encryptWithKey,
  isEnvelope,
  plaintextHash,
  redact,
  sha256Hex,
} from "../commands/myrmidon-migrate-secrets.js";
import {
  checkCompatibility,
  runMigration,
  type MigrationOptions,
} from "../commands/myrmidon-migrate.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../packages/db/src/migrations", import.meta.url));

const SOURCE_KEY = randomBytes(32).toString("base64");
const TARGET_KEY = randomBytes(32).toString("base64");
const WRONG_KEY = randomBytes(32).toString("base64");
const SECRET_VALUE = "fixture-secret-value";

describe("myrmidon:migrate pure guards", () => {
  it("derives the vendor hash chain from the migration files on disk", async () => {
    const chain = await loadVendorChain();
    expect(chain).toHaveLength(278);
    expect(chain[chain.length - 1]![0]).toBe("0279_tired_deathstrike");
    for (const [tag, hash] of chain) {
      expect(hash).toBe(createHash("sha256").update(readFileSync(path.join(MIGRATIONS_DIR, `${tag}.sql`), "utf8")).digest("hex"));
    }
  });

  let chain: Awaited<ReturnType<typeof loadVendorChain>>;
  let releases: VendorRelease[];
  beforeAll(async () => {
    chain = await loadVendorChain();
    releases = await loadVendorReleases();
  });
  const rowsOf = (r: VendorRelease) => r.chain.map((e) => ({ hash: e[1] }));
  const release = (name: string) => releases.find((r) => r.release === name)!;
  const SUPPORTED: [string, number, string][] = [
    ["v2026.916.1", 278, "0279_tired_deathstrike"],
    ["v2026.916.0", 278, "0279_tired_deathstrike"],
    ["v2026.1001.0", 282, "0283_jittery_psynapse"],
    ["v2026.1005.0", 292, "0293_broad_rattler"],
    ["v2026.1012.0", 304, "0305_chubby_vin_gonzales"],
  ];

  it("lists the supported Paperclip releases with their pinned chains", () => {
    expect(releases.map((r) => [r.release, r.chain.length, r.chain[r.chain.length - 1]![0]])).toEqual(SUPPORTED.map((x) => [...x]));
    for (const r of releases) {
      // every release starts with the same base chain, and every hash is a sha256
      expect(r.chain.slice(0, chain.length)).toEqual(chain);
      for (const [, hash] of r.chain) expect(hash).toMatch(/^[0-9a-f]{64}$/);
    }
    // an older release is a prefix of a newer one
    expect(release("v2026.1005.0").chain.slice(0, 282)).toEqual(release("v2026.1001.0").chain);
    expect(release("v2026.1012.0").chain.slice(0, 292)).toEqual(release("v2026.1005.0").chain);
  });

  it.each(SUPPORTED)("accepts exactly the chain of %s and reports its canonical release", (name, length) => {
    const check = checkVendorChain(rowsOf(release(name)), releases);
    const canonicalRelease = name === "v2026.916.0" ? "v2026.916.1" : name;
    expect(check).toMatchObject({ supported: true, vendorRelease: canonicalRelease, applied: length, expected: length });
    expect(check.supportedReleases).toEqual(SUPPORTED.map((x) => x[0]));
  });

  it("accepts the base chain and keeps the target prefix check", () => {
    expect(checkVendorChain(rowsOf(release("v2026.916.1")), releases).supported).toBe(true);
    expect(chainStartsWithVendor([...rowsOf(release("v2026.916.1")), { hash: "x" }], chain)).toBe(true);
    expect(checkVendorChain(null, releases).reason).toBe("no-migration-journal");
    expect(checkVendorChain([], releases).reason).toBe("empty-journal");
  });

  it("rejects a truncated, extended or foreign chain with the right reason", () => {
    const base = rowsOf(release("v2026.916.1"));
    const latest = rowsOf(release("v2026.1012.0"));
    // truncated: one short of each release
    expect(checkVendorChain(base.slice(0, -1), releases).reason).toBe("older-than-supported-release");
    for (const name of ["v2026.1001.0", "v2026.1005.0", "v2026.1012.0"]) {
      const check = checkVendorChain(rowsOf(release(name)).slice(0, -1), releases);
      expect(check.reason).toBe("older-than-supported-release");
      expect(check.vendorRelease).toBe(name);
    }
    // between two supported releases (a half-upgraded source)
    expect(checkVendorChain(latest.slice(0, 285), releases).reason).toBe("older-than-supported-release");
    // extended past the newest supported release
    const newer = checkVendorChain([...latest, { hash: "x" }], releases);
    expect(newer.reason).toBe("newer-than-supported-release");
    expect(newer.detail).toContain("v2026.1012.0");
    expect(checkVendorChain([...base, { hash: "x" }], releases).reason).toBe("newer-than-supported-release");
    // a foreign hash anywhere, including the last row of every release
    for (const r of releases) {
      const rows = rowsOf(r);
      rows[rows.length - 1] = { hash: "f".repeat(64) };
      expect(checkVendorChain(rows, releases).supported).toBe(false);
    }
    const foreign = latest.slice();
    foreign[290] = { hash: "0".repeat(64) };
    const check = checkVendorChain(foreign, releases);
    expect(check).toMatchObject({ supported: false, reason: "hash-mismatch", firstMismatchIndex: 290 });
    // an unknown migration after the base chain is not any supported release
    expect(checkVendorChain([...base, { hash: "1".repeat(64) }, { hash: "2".repeat(64) }, { hash: "3".repeat(64) }, { hash: "4".repeat(64) }], releases).supported).toBe(false);
  });

  it("rejects a chain whose last name/number matches but a hash differs", () => {
    const rows = rowsOf(release("v2026.916.1"));
    rows[100] = { hash: "0".repeat(64) };
    const check = checkVendorChain(rows, releases);
    expect(check.supported).toBe(false);
    expect(check.reason).toBe("hash-mismatch");
    expect(check.firstMismatchIndex).toBe(100);
    const lastOnlyDiffers = rowsOf(release("v2026.916.1"));
    lastOnlyDiffers[lastOnlyDiffers.length - 1] = { hash: "f".repeat(64) };
    expect(checkVendorChain(lastOnlyDiffers, releases).supported).toBe(false);
  });

  it("pins the features that only later releases have", () => {
    const index = buildVendorOnlyIndex();
    expect(index.tables.get("mcp_oauth_clients")).toBe("v2026.1012.0");
    expect(index.tables.size).toBeGreaterThan(20);
    expect(index.columns.get("agents.appearance")).toBeDefined();
    expect(index.columns.get("routine_triggers.archived")).toBeDefined();
    // nothing of the base release is listed as vendor-only
    expect(index.tables.has("agents")).toBe(false);
    expect(index.tables.has("assets")).toBe(false);
  });

  it("excludes features that exist in the target schema from the vendor-only index", () => {
    const targetSchema = {
      tables: new Set(["mcp_oauth_clients", "routine_webhook_test_receipts"]),
      columns: new Set(["agents.appearance"]),
    };
    const index = buildVendorOnlyIndex(undefined, targetSchema);
    expect(index.tables.has("mcp_oauth_clients")).toBe(false);
    expect(index.tables.has("routine_webhook_test_receipts")).toBe(false);
    expect(index.columns.has("agents.appearance")).toBe(false);
    // Features absent from targetSchema and not dropped remain vendor-only:
    expect(index.tables.get("chat_github_configurations")).toBe("v2026.1001.0");
    expect(index.columns.get("routine_triggers.archived")).toBe("v2026.1001.0");
  });

  it("accounts for net migration chain drops such as user.keyboard_shortcuts", () => {
    // user.keyboard_shortcuts was introduced in 0284, but dropped in 0289_drop_user_keyboard_shortcuts
    const index = buildVendorOnlyIndex();
    expect(index.columns.has("user.keyboard_shortcuts")).toBe(false);
    expect(index.droppedColumns?.has("user.keyboard_shortcuts")).toBe(true);
    // Features that were not dropped and are not in target remain vendor-only:
    expect(index.tables.get("chat_github_configurations")).toBe("v2026.1001.0");
    expect(index.columns.get("agents.appearance")).toBe("v2026.1001.0");
  });

  it("loads target schema from our migration tree snapshot", async () => {
    const targetSchema = await loadMigrationTargetSchema();
    expect(targetSchema.tables.has("agents")).toBe(true);
    expect(targetSchema.tables.has("issues")).toBe(true);
    expect(targetSchema.columns.has("agents.id")).toBe(true);
    expect(targetSchema.columns.has("issues.id")).toBe(true);
    // Later vendor-only features are not in current Myrmidon schema:
    expect(targetSchema.tables.has("mcp_oauth_clients")).toBe(false);
    expect(targetSchema.columns.has("agents.appearance")).toBe(false);
  });

  describe("checkCompatibility with features Myrmidon lacks", () => {
    const col = (name: string, over: Partial<ColumnInfo> = {}): ColumnInfo => ({
      name,
      dataType: "text",
      nullable: true,
      hasDefault: false,
      generated: false,
      identityAlways: false,
      hasIdentity: false,
      defaultExpr: null,
      ...over,
    });
    const table = (name: string, cols: ColumnInfo[]): TableInfo => ({ name, columns: cols });
    const analysisOf = (tables: TableInfo[], rows: Record<string, number>, candidates: any[] = []) => ({
      tables: new Map(tables.map((t) => [t.name, t])),
      digests: new Map(tables.map((t) => [t.name, { rows: rows[t.name] ?? 0, digest: "d" }])),
      vendorOnlyCandidates: candidates,
    });
    const index = {
      tables: new Map([["browser_use_runs", "v2026.1012.0"]]),
      columns: new Map([["agents.appearance", "v2026.1012.0"], ["user.keyboard_shortcuts", "v2026.1001.0"]]),
    };

    it("reports a missing vendor-only table and column as findings, not problems", () => {
      const analysis = analysisOf(
        [table("browser_use_runs", [col("id")]), table("agents", [col("id"), col("appearance")]), table("user", [col("id"), col("keyboard_shortcuts")])],
        { browser_use_runs: 3, agents: 5, user: 2 },
        [{ kind: "column", table: "agents", column: "appearance", rows: 4, introducedIn: "v2026.1012.0" }],
      );
      const target = new Map([["agents", table("agents", [col("id")])], ["user", table("user", [col("id")])]]);
      const result = checkCompatibility(analysis, target, index);
      expect(result.problems).toEqual([]);
      expect(result.vendorOnly).toEqual([
        { kind: "table", table: "browser_use_runs", rows: 3, introducedIn: "v2026.1012.0" },
        { kind: "column", table: "agents", column: "appearance", rows: 4, introducedIn: "v2026.1012.0" },
        { kind: "column", table: "user", column: "keyboard_shortcuts", rows: 2, introducedIn: "v2026.1001.0" },
      ]);
    });

    it("keeps every other mismatch an error", () => {
      const analysis = analysisOf(
        [table("mystery", [col("id")]), table("agents", [col("id"), col("surprise")])],
        { mystery: 1, agents: 1 },
      );
      const target = new Map([["agents", table("agents", [col("id")])]]);
      const result = checkCompatibility(analysis, target, index);
      expect(result.problems).toEqual(["table-missing-in-target:mystery", "column-missing-in-target:agents.surprise"]);
      expect(result.vendorOnly).toEqual([]);
    });

    it("excludes empty tables quietly and lets the target lack a column the source dropped", () => {
      const analysis = analysisOf([table("browser_use_runs", [col("id")]), table("user", [col("id")])], { user: 2 });
      // the target still has the dropped column keyboard_shortcuts: nullable, so no value is needed
      const nullable = new Map([["user", table("user", [col("id"), col("keyboard_shortcuts")])]]);
      const ok = checkCompatibility(analysis, nullable, index);
      expect(ok.problems).toEqual([]);
      expect(ok.vendorOnly).toEqual([]);
      expect(ok.exclusions).toEqual([{ kind: "table", name: "browser_use_runs", reason: "absent in target and empty in source" }]);
      expect(ok.skippedSourceData).toEqual([
        { table: "browser_use_runs", rows: 0, vendorRelease: "v2026.1012.0", decision: "excluded-empty" },
      ]);
      const required = new Map([["user", table("user", [col("id"), col("keyboard_shortcuts", { nullable: false })])]]);
      expect(checkCompatibility(analysis, required, index).problems).toEqual(["target-column-requires-value:user.keyboard_shortcuts"]);
    });

    it("reports a vendor-only column of an empty table as excluded-empty, as the dry-run does", () => {
      const analysis = analysisOf(
        [table("agents", [col("id"), col("appearance")]), table("user", [col("id"), col("surprise")])],
        { agents: 0, user: 0 },
      );
      const target = new Map([["agents", table("agents", [col("id")])], ["user", table("user", [col("id")])]]);
      const result = checkCompatibility(analysis, target, index);
      // an unknown column of an empty table is still no problem; a known vendor-only one is reported
      expect(result.problems).toEqual([]);
      expect(result.skippedSourceData).toEqual([
        { table: "agents", column: "appearance", rows: 0, vendorRelease: "v2026.1012.0", decision: "excluded-empty" },
      ]);
    });

    it("treats columns dropped in migration chain as exclusions, not missing errors", () => {
      const droppedIndex: VendorOnlyIndex = {
        tables: new Map(),
        columns: new Map(),
        droppedColumns: new Set(["user.keyboard_shortcuts"]),
      };
      const analysis = analysisOf([table("user", [col("id"), col("keyboard_shortcuts")])], { user: 2 });
      const target = new Map([["user", table("user", [col("id")])]]);
      const result = checkCompatibility(analysis, target, droppedIndex);
      expect(result.problems).toEqual([]);
      expect(result.vendorOnly).toEqual([]);
      expect(result.exclusions).toEqual([
        { kind: "column", name: "user.keyboard_shortcuts", reason: "dropped in migration chain; not needed in target" },
      ]);
    });

    it("accepts unknown tables when acceptUnknownSourceObjects is enabled", () => {
      const analysis = analysisOf([table("custom_extension", [col("id")])], { custom_extension: 2 });
      const target = new Map();
      const rejected = checkCompatibility(analysis, target, index);
      expect(rejected.problems).toEqual(["table-missing-in-target:custom_extension"]);

      const vendorFlagOnly = checkCompatibility(analysis, target, index, { acceptVendorOnlyData: true });
      expect(vendorFlagOnly.problems).toEqual(["table-missing-in-target:custom_extension"]);

      const accepted = checkCompatibility(analysis, target, index, { acceptUnknownSourceObjects: true });
      expect(accepted.problems).toEqual([]);
      expect(accepted.exclusions).toEqual([{ kind: "table", name: "custom_extension", reason: "unknown source table accepted by flag" }]);
    });
  });

  it("guards object keys and manifest paths against traversal", () => {
    expect(normalizeObjectKey("a\\b/c.txt")).toBe("a/b/c.txt");
    expect(normalizeObjectKey("../x")).toBeNull();
    expect(normalizeObjectKey("/abs")).toBeNull();
    expect(() => resolveWithin("/tmp/root", "../escape")).toThrow(/unsafe/);
    expect(() => resolveWithin("/tmp/root", "a/../../escape")).toThrow(/unsafe/);
    expect(resolveWithin("/tmp/root", "a/b")).toBe("/tmp/root/a/b");
  });

  it("hashes files, refuses symlinks and never overwrites different content", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "myrm-files-"));
    try {
      const src = path.join(root, "src");
      const dst = path.join(root, "dst");
      mkdirSync(path.join(src, "d"), { recursive: true });
      writeFileSync(path.join(src, "d/a.txt"), "alpha");
      const entries = await inventoryDirectory(src);
      expect(entries).toMatchObject([{ path: "d/a.txt", sizeBytes: 5 }]);
      await copyManifest(src, dst, entries);
      expect(readFileSync(path.join(dst, "d/a.txt"), "utf8")).toBe("alpha");
      // identical file: resume is a no-op
      expect((await copyManifest(src, dst, entries)).skippedIdentical).toBe(1);
      // different file at the target: refuse
      writeFileSync(path.join(dst, "d/a.txt"), "other");
      await expect(copyManifest(src, dst, entries)).rejects.toThrow(/different content/);
      symlinkSync(path.join(src, "d/a.txt"), path.join(src, "link.txt"));
      await expect(inventoryDirectory(src)).rejects.toThrow(/symlink/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds envelopes anywhere in JSON and redacts secrets from text", async () => {
    const envelope = await encryptWithKey(SOURCE_KEY, SECRET_VALUE);
    expect(isEnvelope(envelope)).toBe(true);
    const nested = { a: [{ b: envelope }], c: { d: envelope }, e: "plain" };
    expect(countCarriers(nested)).toBe(2);
    expect(collectEnvelopes(nested)).toHaveLength(2);
    expect(await plaintextHash(SOURCE_KEY, collectEnvelopes(nested)[0]!)).toBe(sha256Hex(SECRET_VALUE));
    await expect(plaintextHash(WRONG_KEY, collectEnvelopes(nested)[0]!)).rejects.toThrow();
    expect(redact("postgres://u:hunter2@h/db failed", ["postgres://u:hunter2@h/db", "hunter2"])).toBe("[redacted] failed");
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres myrmidon:migrate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const AGENT_A = "33333333-3333-4333-8333-333333333333";
const ISSUE_A = "44444444-4444-4444-8444-444444444444";
const SECRET_A = "55555555-5555-4555-8555-555555555555";
const DOC_A = "66666666-6666-4666-8666-666666666666";
const FILE_BODY = "attachment-body";

describeEmbeddedPostgres("myrmidon:migrate against a real Postgres", () => {
  let cluster: EmbeddedPostgresTestDatabase;
  let adminUrl = "";
  let templateUrl = "";
  let counter = 0;
  const tmpDirs: string[] = [];

  const urlFor = (name: string) => adminUrl.replace(/\/[^/]*$/, `/${name}`);
  const tmp = (prefix: string) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
    tmpDirs.push(dir);
    return dir;
  };

  async function newDatabase(prefix: string, template?: string): Promise<string> {
    counter += 1;
    const name = `${prefix}_${process.pid}_${counter}`;
    if (template) {
      const db = createDb(adminUrl);
      await db.execute(sql.raw(`create database "${name}" template "${template}"`));
      await closeRegisteredClients(adminUrl);
    } else {
      await ensurePostgresDatabase(adminUrl, name);
    }
    return urlFor(name);
  }

  async function buildVendorTemplate(): Promise<void> {
    const folder = tmp("myrm-vendor-migrations");
    mkdirSync(path.join(folder, "meta"));
    const journal = JSON.parse(readFileSync(path.join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8")) as {
      entries: { idx: number; tag: string }[];
    };
    const vendor = journal.entries.filter((e) => e.idx <= 279);
    for (const entry of vendor) copyFileSync(path.join(MIGRATIONS_DIR, `${entry.tag}.sql`), path.join(folder, `${entry.tag}.sql`));
    writeFileSync(path.join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries: vendor }));
    await ensurePostgresDatabase(adminUrl, "vendor_template");
    templateUrl = urlFor("vendor_template");
    const db = createDb(templateUrl);
    await migrate(db as never, { migrationsFolder: folder });

    const envelope = await encryptWithKey(SOURCE_KEY, SECRET_VALUE);
    const seed = async (query: string) => db.execute(sql.raw(query));
    const lit = (v: unknown) => `'${String(v).replaceAll("'", "''")}'`;
    await seed(`insert into companies (id, name, issue_prefix) values (${lit(COMPANY_A)}, 'Alpha', 'ALP'), (${lit(COMPANY_B)}, 'Beta', 'BET')`);
    await seed(
      `insert into agents (id, company_id, name, adapter_config) values (${lit(AGENT_A)}, ${lit(COMPANY_A)}, 'Agent One', ${lit(JSON.stringify({ token: envelope, keep: 1 }))}::jsonb)`,
    );
    await seed(`insert into projects (company_id, name) values (${lit(COMPANY_A)}, 'Project One')`);
    await seed(`insert into issues (id, company_id, title) values (${lit(ISSUE_A)}, ${lit(COMPANY_A)}, 'Issue One')`);
    await seed(`insert into issue_comments (company_id, issue_id, body) values (${lit(COMPANY_A)}, ${lit(ISSUE_A)}, 'Comment One')`);
    await seed(`insert into documents (id, company_id, latest_body) values (${lit(DOC_A)}, ${lit(COMPANY_A)}, 'Doc body')`);
    await seed(`insert into issue_documents (company_id, issue_id, document_id, key) values (${lit(COMPANY_A)}, ${lit(ISSUE_A)}, ${lit(DOC_A)}, 'plan')`);
    await seed(`insert into company_skills (company_id, key, slug, name, markdown) values (${lit(COMPANY_A)}, 'k', 's', 'Skill', '# md')`);
    await seed(`insert into heartbeat_runs (company_id, agent_id) values (${lit(COMPANY_A)}, ${lit(AGENT_A)})`);
    await seed(`insert into company_secrets (id, company_id, key, name) values (${lit(SECRET_A)}, ${lit(COMPANY_A)}, 'api_key', 'API key')`);
    await seed(
      `insert into company_secret_versions (secret_id, version, material, value_sha256, fingerprint_sha256) values (${lit(SECRET_A)}, 1, ${lit(JSON.stringify(envelope))}::jsonb, ${lit(sha256Hex(SECRET_VALUE))}, ${lit(sha256Hex(SECRET_VALUE))})`,
    );
    await seed(
      `insert into assets (company_id, provider, object_key, content_type, byte_size, sha256) values (${lit(COMPANY_A)}, 'local_disk', 'company-a/note.txt', 'text/plain', ${FILE_BODY.length}, ${lit(sha256Hex(FILE_BODY))})`,
    );
    await closeRegisteredClients(templateUrl);
  }

  beforeAll(async () => {
    cluster = await startEmbeddedPostgresTestDatabase("myrmidon-migrate-");
    adminUrl = cluster.connectionString.replace(/\/[^/]*$/, "/postgres");
    await buildVendorTemplate();
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS * 3);

  afterAll(async () => {
    await cluster?.cleanup();
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS * 3);

  type Fixture = {
    sourceUrl: string;
    targetUrl: string;
    sourceFiles: string;
    targetDir: string;
    stateDir: string;
    options: MigrationOptions;
  };

  async function fixture(): Promise<Fixture> {
    const root = tmp("myrm-run");
    const sourceFiles = path.join(root, "source-files");
    mkdirSync(path.join(sourceFiles, "company-a"), { recursive: true });
    writeFileSync(path.join(sourceFiles, "company-a/note.txt"), FILE_BODY);
    const sourceUrl = await newDatabase("src", "vendor_template");
    const targetUrl = await newDatabase("tgt");
    const targetDir = path.join(root, "target-files");
    const stateDir = path.join(root, "state");
    return {
      sourceUrl,
      targetUrl,
      sourceFiles,
      targetDir,
      stateDir,
      options: {
        sourceUrl,
        targetUrl,
        sourceFiles,
        targetDir,
        stateDir,
        env: { SRC_KEY: SOURCE_KEY, TGT_KEY: TARGET_KEY },
        sourceKeyEnv: "SRC_KEY",
        targetKeyEnv: "TGT_KEY",
      },
    };
  }

  async function scalar(url: string, query: string): Promise<string> {
    const db = createDb(url);
    try {
      const rows = Array.from((await db.execute(sql.raw(query))) as unknown as Record<string, unknown>[]);
      return String(Object.values(rows[0] ?? {})[0] ?? "");
    } finally {
      await closeRegisteredClients(url);
    }
  }

  const publicTables = (url: string) =>
    scalar(url, "select count(*) from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'");
  const sourceFingerprint = (url: string) =>
    scalar(
      url,
      `select md5(coalesce((select string_agg(c::text, ',' order by c::text) from companies c), '') || (select count(*)::text from issues) || (select string_agg(hash, ',' order by id) from drizzle.__drizzle_migrations))`,
    );

  async function expectZeroWrites(f: Fixture) {
    expect(await publicTables(f.targetUrl)).toBe("0");
    expect(await scalar(f.targetUrl, "select count(*) from pg_namespace where nspname = 'drizzle'")).toBe("0");
    expect(existsSync(f.targetDir)).toBe(false);
    expect(existsSync(f.stateDir)).toBe(false);
  }

  const T = EMBEDDED_POSTGRES_TEST_TIMEOUT_MS * 3;

  it("dry-run reports a full inventory and writes nothing", async () => {
    const f = await fixture();
    const before = await sourceFingerprint(f.sourceUrl);
    const result = (await runMigration({ ...f.options, dryRun: true })) as Record<string, any>;
    expect(result.status).toBe("ok");
    expect(result.writesPerformed).toBe(false);
    expect(result.source.chain).toMatchObject({ expected: 278, applied: 278, matches: true });
    const byName = Object.fromEntries(result.inventory.tables.map((t: any) => [t.name, t.rows]));
    expect(byName).toMatchObject({ companies: 2, agents: 1, issues: 1, issue_comments: 1, company_secret_versions: 1, assets: 1 });
    expect(result.inventory.secretCarriers.total).toBe(2);
    expect(result.inventory.files.count).toBe(1);
    expect(JSON.stringify(result)).not.toContain(f.sourceUrl);
    await expectZeroWrites(f);
    expect(await sourceFingerprint(f.sourceUrl)).toBe(before);
  }, T);

  it("prechecks vendor-only data against migration tree target schema: ignores dropped columns and requires flag only for truly absent features", async () => {
    const f = await fixture();
    // 1. Source database has data in user.keyboard_shortcuts (which was dropped in 0289 in the migration chain)
    await scalar(f.sourceUrl, 'alter table "user" add column if not exists "keyboard_shortcuts" jsonb');
    await scalar(
      f.sourceUrl,
      "insert into \"user\" (id, name, email, created_at, updated_at, keyboard_shortcuts) values ('88888888-8888-4888-8888-888888888888', 'Shortcuts User', 'sc@test.local', now(), now(), '{\"ctrl_k\": true}')",
    );

    // Dry-run through production precheck: user.keyboard_shortcuts does NOT require the flag
    const dry = (await runMigration({ ...f.options, dryRun: true })) as Record<string, any>;
    expect(dry.status).toBe("ok");
    expect(dry.vendorOnlyData.requiresFlag).toBe(false);
    expect(dry.vendorOnlyData.withData).toEqual([]);

    // Real run without --accept-vendor-only-data succeeds without error
    const runResult = (await runMigration(f.options)) as Record<string, any>;
    expect(runResult.status).toBe("ok");
    expect(runResult.phases).toContain("data");

    // 2. Now test with a fresh fixture containing data in a feature that is TRULY absent from the target schema (e.g. agents.appearance)
    const f2 = await fixture();
    await scalar(f2.sourceUrl, 'alter table "user" add column if not exists "keyboard_shortcuts" jsonb');
    await scalar(
      f2.sourceUrl,
      "insert into \"user\" (id, name, email, created_at, updated_at, keyboard_shortcuts) values ('88888888-8888-4888-8888-888888888888', 'Shortcuts User', 'sc@test.local', now(), now(), '{\"ctrl_k\": true}')",
    );
    await scalar(f2.sourceUrl, 'alter table "agents" add column if not exists "appearance" jsonb');
    await scalar(f2.sourceUrl, "update \"agents\" set \"appearance\" = '{\"theme\": \"dark\"}'::jsonb");

    // Production precheck dry run detects the truly vendor-only feature and requires the flag
    const dry2 = (await runMigration({ ...f2.options, dryRun: true })) as Record<string, any>;
    expect(dry2.status).toBe("ok");
    expect(dry2.vendorOnlyData.requiresFlag).toBe(true);
    expect(dry2.vendorOnlyData.withData).toMatchObject([{ table: "agents", column: "appearance" }]);
    expect(dry2.vendorOnlyData.withData.some((c: any) => c.column === "keyboard_shortcuts")).toBe(false);

    // Real run without --accept-vendor-only-data refuses before any target write
    await expect(runMigration(f2.options)).rejects.toThrow(/accept-vendor-only-data/);
    await expectZeroWrites(f2);

    // Real run with --accept-vendor-only-data succeeds
    const runWithFlag = (await runMigration({ ...f2.options, acceptVendorOnlyData: true })) as Record<string, any>;
    expect(runWithFlag.status).toBe("ok");
  }, T * 2);

  it("rejects unsupported source histories before any target write", async () => {
    for (const tamper of [
      "update drizzle.__drizzle_migrations set hash = repeat('0', 64) where id = (select max(id) from drizzle.__drizzle_migrations)",
      "delete from drizzle.__drizzle_migrations where id = (select max(id) from drizzle.__drizzle_migrations)",
      "insert into drizzle.__drizzle_migrations (hash, created_at) values (repeat('a', 64), 1)",
    ]) {
      const f = await fixture();
      await scalar(f.sourceUrl, `${tamper} returning 1`).catch(() => undefined);
      await expect(runMigration(f.options)).rejects.toThrow(/Unsupported source schema/);
      await expectZeroWrites(f);
    }
  }, T);

  it("rejects a wrong or unusable key with zero writes", async () => {
    const f = await fixture();
    await expect(runMigration({ ...f.options, env: { SRC_KEY: WRONG_KEY, TGT_KEY: TARGET_KEY } })).rejects.toThrow(/does not decrypt/);
    await expectZeroWrites(f);
    await expect(runMigration({ ...f.options, env: { SRC_KEY: "not-a-key", TGT_KEY: TARGET_KEY } })).rejects.toThrow(/not a valid secrets master key/);
    await expectZeroWrites(f);
  }, T);

  it("migrates from a URL with counts, content, files and secrets verified, and leaves the source unchanged", async () => {
    const f = await fixture();
    const before = await sourceFingerprint(f.sourceUrl);
    const dry = (await runMigration({ ...f.options, dryRun: true })) as Record<string, any>;
    const result = (await runMigration(f.options)) as Record<string, any>;
    expect(result.status).toBe("ok");
    expect(result.phases).toEqual(["schema", "data", "files", "verify", "complete"]);
    // dry-run / fact parity
    expect(result.inventory).toEqual(dry.inventory);
    expect(result.verification.countsAndContentMatch).toBe(true);
    expect(result.verification.sourceUnchanged).toBe(true);
    expect(result.verification.secrets).toMatchObject({ total: 2, decryptWithTargetKey: true, plaintextParity: true, oldKeyRejected: true });
    for (const t of result.verification.tables) expect(t.match).toBe(true);
    // facts read straight from the target
    expect(await scalar(f.targetUrl, "select count(*) from companies")).toBe("2");
    expect(await scalar(f.targetUrl, `select title from issues where id = '${ISSUE_A}'`)).toBe("Issue One");
    expect(await scalar(f.targetUrl, `select count(*) from issue_documents where issue_id = '${ISSUE_A}'`)).toBe("1");
    const material = JSON.parse(await scalar(f.targetUrl, "select material::text from company_secret_versions"));
    expect(await plaintextHash(TARGET_KEY, material)).toBe(sha256Hex(SECRET_VALUE));
    await expect(plaintextHash(SOURCE_KEY, material)).rejects.toThrow();
    const agentConfig = JSON.parse(await scalar(f.targetUrl, "select adapter_config::text from agents"));
    expect(agentConfig.keep).toBe(1);
    expect(await plaintextHash(TARGET_KEY, agentConfig.token)).toBe(sha256Hex(SECRET_VALUE));
    expect(readFileSync(path.join(f.targetDir, "company-a/note.txt"), "utf8")).toBe(FILE_BODY);
    const journal = JSON.parse(readFileSync(path.join(f.stateDir, "journal.json"), "utf8"));
    expect(journal.status).toBe("complete");
    expect(JSON.stringify(journal)).not.toContain("password");
    expect(await sourceFingerprint(f.sourceUrl)).toBe(before);
    expect(existsSync(path.join(f.stateDir, "lock"))).toBe(false);
  }, T);

  it("is idempotent: a re-run adds no rows and reports already-migrated", async () => {
    const f = await fixture();
    await runMigration(f.options);
    const rows = await scalar(f.targetUrl, "select (select count(*) from companies) + (select count(*) from issues) + (select count(*) from company_secret_versions)");
    const again = (await runMigration(f.options)) as Record<string, any>;
    expect(again.status).toBe("already-migrated");
    expect(again.writesPerformed).toBe(false);
    expect(await scalar(f.targetUrl, "select (select count(*) from companies) + (select count(*) from issues) + (select count(*) from company_secret_versions)")).toBe(rows);
  }, T);

  it("resumes after an injected failure at every phase without duplicates", async () => {
    for (const injection of ["after-schema", "mid-data", "after-data-commit", "after-first-file", "after-files"] as const) {
      const f = await fixture();
      await expect(runMigration({ ...f.options, failureInjection: injection })).rejects.toThrow(/Injected failure/);
      const journal = JSON.parse(readFileSync(path.join(f.stateDir, "journal.json"), "utf8"));
      expect(journal.status).toBe("failed");
      if (injection === "mid-data") {
        // the load is one transaction: nothing of it may remain
        expect(await scalar(f.targetUrl, "select count(*) from companies")).toBe("0");
      }
      const resumed = (await runMigration(f.options)) as Record<string, any>;
      expect(resumed.status).toBe("ok");
      expect(resumed.verification.countsAndContentMatch).toBe(true);
      expect(await scalar(f.targetUrl, "select count(*) from companies")).toBe("2");
      expect(await scalar(f.targetUrl, "select count(*) from issue_comments")).toBe("1");
      expect(readFileSync(path.join(f.targetDir, "company-a/note.txt"), "utf8")).toBe(FILE_BODY);
    }
  }, T * 2);

  it("refuses a foreign non-empty target database or directory and leaves them intact", async () => {
    const f = await fixture();
    await scalar(f.targetUrl, "create table foreign_table (id int)").catch(() => undefined);
    await expect(runMigration(f.options)).rejects.toThrow(/non-empty target database/);
    expect(await publicTables(f.targetUrl)).toBe("1");
    expect(existsSync(f.stateDir)).toBe(false);

    const g = await fixture();
    mkdirSync(g.targetDir, { recursive: true });
    writeFileSync(path.join(g.targetDir, "keep.txt"), "mine");
    await expect(runMigration(g.options)).rejects.toThrow(/non-empty target directory/);
    expect(readFileSync(path.join(g.targetDir, "keep.txt"), "utf8")).toBe("mine");
    expect(await publicTables(g.targetUrl)).toBe("0");
  }, T);

  it("rolls back only what the run created", async () => {
    const f = await fixture();
    await scalar(f.targetUrl, "create function public.keep_me() returns int language sql as 'select 1'").catch(() => undefined);
    await runMigration(f.options);
    expect(existsSync(path.join(f.targetDir, "company-a/note.txt"))).toBe(true);
    const rolled = (await runMigration({ ...f.options, rollback: true })) as Record<string, any>;
    expect(rolled.status).toBe("rolled-back");
    expect(await publicTables(f.targetUrl)).toBe("0");
    expect(await scalar(f.targetUrl, "select count(*) from pg_namespace where nspname = 'drizzle'")).toBe("0");
    expect(await scalar(f.targetUrl, "select public.keep_me()")).toBe("1");
    expect(readdirSync(f.targetDir)).toEqual([]);
    // a rolled-back target can be used again
    const again = (await runMigration(f.options)) as Record<string, any>;
    expect(again.status).toBe("ok");
  }, T * 2);

  it("migrates from a pg_dump-style file restored into a scratch database", async () => {
    const f = await fixture();
    const dumpDir = tmp("myrm-dump");
    const backup = await runDatabaseBackup({
      connectionString: f.sourceUrl,
      backupDir: dumpDir,
      retention: { dailyDays: 1, weeklyWeeks: 1, monthlyMonths: 1 },
      backupEngine: "javascript",
    });
    const scratchUrl = await newDatabase("scratch");
    const options: MigrationOptions = { ...f.options, sourceUrl: undefined, sourceDump: backup.backupFile, scratchUrl };
    const dry = (await runMigration({ ...options, dryRun: true })) as Record<string, any>;
    expect(dry.source.kind).toBe("dump");
    expect(dry.source.dump.sha256).toMatch(/^[0-9a-f]{64}$/);
    await expectZeroWrites(f);
    // the scratch database is consumed by the dry run; use a fresh one for the transfer
    const scratch2 = await newDatabase("scratch");
    const result = (await runMigration({ ...options, scratchUrl: scratch2 })) as Record<string, any>;
    expect(result.status).toBe("ok");
    expect(result.inventory.tables).toEqual(dry.inventory.tables);
    expect(await scalar(f.targetUrl, "select count(*) from issues")).toBe("1");
    const material = JSON.parse(await scalar(f.targetUrl, "select material::text from company_secret_versions"));
    expect(await plaintextHash(TARGET_KEY, material)).toBe(sha256Hex(SECRET_VALUE));
  }, T * 2);

  it("fails closed when the dump holds an unsupported history", async () => {
    const f = await fixture();
    await scalar(f.sourceUrl, "delete from drizzle.__drizzle_migrations where id = (select max(id) from drizzle.__drizzle_migrations) returning 1");
    const dumpDir = tmp("myrm-dump");
    const backup = await runDatabaseBackup({
      connectionString: f.sourceUrl,
      backupDir: dumpDir,
      retention: { dailyDays: 1, weeklyWeeks: 1, monthlyMonths: 1 },
      backupEngine: "javascript",
    });
    const scratchUrl = await newDatabase("scratch");
    await expect(
      runMigration({ ...f.options, sourceUrl: undefined, sourceDump: backup.backupFile, scratchUrl }),
    ).rejects.toThrow(/Unsupported source schema/);
    await expectZeroWrites(f);
  }, T * 2);

  it("keeps URLs and keys out of errors", async () => {
    const f = await fixture();
    const secretUrl = f.sourceUrl;
    const error = await runMigration({ ...f.options, sourceUrl: secretUrl, env: { SRC_KEY: WRONG_KEY, TGT_KEY: TARGET_KEY } }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    const text = String((error as Error).message);
    expect(text).not.toContain(WRONG_KEY);
    expect(text).not.toContain(secretUrl);
  }, T);
});
