// myrmidon(OPE-4996): fork-owned test — every backup/restore connection must
// run with session statement_timeout = 0, so a database-level timeout (ALTER
// DATABASE ... SET statement_timeout) cannot abort a long dump. The COPY,
// JavaScript-cursor, pg_dump-env and psql-env cases are red against the
// pre-fix backup-lib.ts, green with the fix.
//
// Why one shared cluster: the guard and the engine cases all need the same
// table whose COPY provably runs longer than the 1 s limit. Loading 1M rows
// once in beforeAll keeps the suite inside the CI job budget; each dump still
// writes to its own temp directory.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

import { runDatabaseBackup, runDatabaseRestore } from "./backup-lib.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// Budget per test: the heaviest steps are the 1M-row JavaScript cursor dump
// (one INSERT statement per formatted row) and the COPY stream (~500 MB of
// text). Normally far below this; the budget only absorbs a contended runner.
const BIG_TEST_TIMEOUT_MS = 900_000;
const CLUSTER_HOOK_TIMEOUT_MS = 900_000;

const PROBE_SCHEMA = "backup_timeout_probe";
const PROBE_TABLE = `${PROBE_SCHEMA}.timeout_rows`;
const PROBE_EXCLUDED_TABLE = `${PROBE_SCHEMA}.probe_excluded`;
const PROBE_ROWS = 1_000_000;
// The database-level limit this suite fights with. The live stand ran 120 s;
// 1 s reproduces the same 57014 class here with a 1M-row table.
const DB_STATEMENT_TIMEOUT = "1s";

const cleanups: Array<() => Promise<void> | void> = [];
let bigConnectionString = "";

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

// Connection without any backup options — an "ordinary session" like the
// board's own app connections use (onnotice matches the other backup suites).
function plainClient(connectionString: string) {
  const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
  cleanups.push(() => sql.end().catch(() => {}));
  return sql;
}

async function setDatabaseStatementTimeout(connectionString: string, value: string): Promise<void> {
  const databaseName = decodeURIComponent(new URL(connectionString).pathname.replace(/^\//, ""));
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(databaseName)) {
    throw new Error(`Unsafe database name: ${databaseName}`);
  }
  const adminUrl = new URL(connectionString);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`ALTER DATABASE "${databaseName}" SET statement_timeout = '${value}'`);
  } finally {
    await admin.end();
  }
}

// A table whose COPY provably runs longer than the 1 s limit: 1M rows with a
// ~512-character payload of concatenated distinct md5 digests. High entropy,
// so the gzipped dump stays large enough to prove the rows really streamed.
async function createBigTimeoutProbeTable(connectionString: string): Promise<void> {
  const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${PROBE_SCHEMA}";`);
    await sql.unsafe(`
      CREATE TABLE ${PROBE_TABLE} (
        id bigint PRIMARY KEY,
        payload text NOT NULL
      );
    `);
    await sql.unsafe(`
      INSERT INTO ${PROBE_TABLE} (id, payload)
      SELECT g,
             (SELECT string_agg(md5(g::text || i::text), '') FROM generate_series(1, 16) AS i)
      FROM generate_series(1, ${PROBE_ROWS}) AS g;
    `);
    // A single-row table used only to switch the dump onto the transform
    // path (COPY-to-STDOUT per table) via excludeTables.
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${PROBE_EXCLUDED_TABLE} (id int PRIMARY KEY);`,
    );
    await sql.unsafe(`INSERT INTO ${PROBE_EXCLUDED_TABLE} (id) VALUES (1) ON CONFLICT DO NOTHING;`);
  } finally {
    await sql.end();
  }
}

// Stub libpq client that records the PGOPTIONS it was launched with and then
// behaves like a minimal successful run, so the pg_dump/psql spawn env is
// asserted even on hosts without the real client binaries (the embedded
// Postgres package ships neither).
function writePgClientStub(name: string, envFile: string, mode: "dump" | "restore"): string {
  const dir = createTempDir(`paperclip-${name}-stub-`);
  const bin = path.join(dir, name);
  const body = mode === "dump"
    ? "printf 'BEGIN;\\nSELECT 1;\\nCOMMIT;\\n'"
    : "cat > /dev/null";
  // Recorded line: `PGOPTIONS=[<value>]`, with `missing` when the library
  // set nothing. Built by concatenation because the shell's `${VAR-word}`
  // expansion is not expressible safely inside a JS template literal.
  const recordLine =
    "printf 'PGOPTIONS=[%s]\\n' \"" +
    "$" +
    "{PGOPTIONS-missing}\" > \"" +
    envFile +
    "\"";
  fs.writeFileSync(
    bin,
    ["#!/bin/sh", recordLine, body, "exit 0", ""].join("\n"),
    { mode: 0o755 },
  );
  return bin;
}

function pgDumpMajor(): number | null {
  const bin = process.env.PAPERCLIP_PG_DUMP_PATH || "pg_dump";
  const probe = spawnSync(bin, ["--version"], { encoding: "utf8" });
  if (probe.status !== 0) return null;
  const match = /(\d+)\./.exec(probe.stdout ?? "");
  return match ? Number(match[1]) : null;
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres statement-timeout backup tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("backup/restore statement_timeout override (OPE-4996)", () => {
  beforeAll(async () => {
    // Fresh cluster; the big table is loaded unrestricted, then the limit is
    // set last. ALTER DATABASE ... SET applies to every NEW session, which
    // is exactly what the backup opens, while connections established before
    // it (none of these tests reuse one) keep the old default.
    const db = await startEmbeddedPostgresTestDatabase("paperclip-backup-statement-timeout-");
    cleanups.push(db.cleanup);
    bigConnectionString = db.connectionString;
    await createBigTimeoutProbeTable(bigConnectionString);
    await setDatabaseStatementTimeout(bigConnectionString, DB_STATEMENT_TIMEOUT);
  }, CLUSTER_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      await cleanup?.();
    }
  }, CLUSTER_HOOK_TIMEOUT_MS);

  it(
    "guard: a plain session against the timeout-limited database is killed with 57014",
    async () => {
      // Deterministic proof the database-level default is in force for new
      // ordinary sessions: pg_sleep(2) is cancelled at 1 s. (pg_sleep rather
      // than a big-table count(*) because a hot-cache count can slip under
      // 1 s — the guard must not flake.) This is the exact environment the
      // live backup ran into: the stand's 120 s limit aborting a
      // multi-hundred-MB COPY with PostgresError 57014.
      const plain = plainClient(bigConnectionString);
      const error = await plain`SELECT pg_sleep(2)`.then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error, "plain session must hit the database-level statement_timeout").toBeTruthy();
      expect((error as { code?: string }).code).toBe("57014");
      expect(String((error as Error).message)).toMatch(/statement timeout/i);
    },
    BIG_TEST_TIMEOUT_MS,
  );

  it(
    "engine auto (COPY-to-STDOUT path) dumps the big table despite the database-level timeout",
    async () => {
      // The per-table `COPY ... TO STDOUT` runs on its own connection and is
      // the longest single statement of the whole backup — the statement
      // class that aborted on the live stand. A single-row excluded table
      // switches the run onto the transform path, which always streams COPY
      // (engine auto never spawns the plain pg_dump child when transforms
      // are set). Red before the fix: the COPY session inherits the 1 s
      // database default and dies mid-COPY (or at the table count).
      const backupDir = createTempDir("paperclip-statement-timeout-copy-");
      const result = await runDatabaseBackup({
        connectionString: bigConnectionString,
        backupDir,
        retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
        filenamePrefix: "paperclip-test",
        backupEngine: "auto",
        excludeTables: [`${PROBE_SCHEMA}.probe_excluded`],
      });

      expect(fs.existsSync(result.backupFile)).toBe(true);
      // High-entropy md5-hex payload: a complete 1M-row COPY gzips to well
      // over this floor, while a dump truncated at the first timeout carries
      // almost nothing.
      expect(result.sizeBytes).toBeGreaterThan(50_000_000);
    },
    BIG_TEST_TIMEOUT_MS,
  );

  it(
    "javascript engine dumps the big table with the database-level timeout set",
    async () => {
      // The cursor path reads the table through one long-lived portal on the
      // main backup connection; the database-level limit kills the portal
      // mid-dump without the session override.
      const backupDir = createTempDir("paperclip-statement-timeout-js-");
      const result = await runDatabaseBackup({
        connectionString: bigConnectionString,
        backupDir,
        retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
        filenamePrefix: "paperclip-test",
        backupEngine: "javascript",
      });

      expect(result.backupFile).toMatch(/paperclip-test-.*\.sql\.gz$/);
      expect(fs.existsSync(result.backupFile)).toBe(true);
    },
    BIG_TEST_TIMEOUT_MS,
  );

  it(
    "pg_dump child is spawned with PGOPTIONS carrying the session statement_timeout override",
    async () => {
      // Deterministic env capture: runs on hosts without a real pg_dump and
      // does not depend on timing. Pre-fix code sets no PGOPTIONS at all, so
      // the stub records `<unset>` — red before the fix.
      const backupDir = createTempDir("paperclip-statement-timeout-pgdump-env-");
      const envFile = path.join(backupDir, "pg-dump-env.txt");
      const previousPgDumpPath = process.env.PAPERCLIP_PG_DUMP_PATH;
      const previousPgOptions = process.env.PGOPTIONS;
      // Start from a clean env so the assertion checks exactly what the
      // library adds, not an inherited value.
      delete process.env.PGOPTIONS;
      process.env.PAPERCLIP_PG_DUMP_PATH = writePgClientStub("pg_dump", envFile, "dump");
      try {
        await runDatabaseBackup({
          connectionString: bigConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-test",
          backupEngine: "pg_dump",
        });
      } finally {
        if (previousPgDumpPath === undefined) delete process.env.PAPERCLIP_PG_DUMP_PATH;
        else process.env.PAPERCLIP_PG_DUMP_PATH = previousPgDumpPath;
        if (previousPgOptions === undefined) delete process.env.PGOPTIONS;
        else process.env.PGOPTIONS = previousPgOptions;
      }

      const captured = fs.readFileSync(envFile, "utf8");
      expect(captured.trim()).toBe("PGOPTIONS=[-c statement_timeout=0]");
    },
    BIG_TEST_TIMEOUT_MS,
  );

  it(
    "psql restore child is spawned with PGOPTIONS carrying the session statement_timeout override",
    async () => {
      const restoreDir = createTempDir("paperclip-statement-timeout-psql-env-");
      const envFile = path.join(restoreDir, "psql-env.txt");
      const backupFile = path.join(restoreDir, "paperclip-test-20260101-000000.sql");
      fs.writeFileSync(backupFile, "BEGIN;\nSELECT 1;\nCOMMIT;\n", "utf8");

      const previousPsqlPath = process.env.PAPERCLIP_PSQL_PATH;
      const previousPgOptions = process.env.PGOPTIONS;
      delete process.env.PGOPTIONS;
      process.env.PAPERCLIP_PSQL_PATH = writePgClientStub("psql", envFile, "restore");
      try {
        await runDatabaseRestore({ connectionString: bigConnectionString, backupFile });
      } finally {
        if (previousPsqlPath === undefined) delete process.env.PAPERCLIP_PSQL_PATH;
        else process.env.PAPERCLIP_PSQL_PATH = previousPsqlPath;
        if (previousPgOptions === undefined) delete process.env.PGOPTIONS;
        else process.env.PGOPTIONS = previousPgOptions;
      }

      const captured = fs.readFileSync(envFile, "utf8");
      expect(captured.trim()).toBe("PGOPTIONS=[-c statement_timeout=0]");
    },
    BIG_TEST_TIMEOUT_MS,
  );

  it(
    "real pg_dump binary (when present and server-version-compatible): engine pg_dump completes against the timeout-limited database",
    async () => {
      // pg_dump refuses a server newer than itself and runners differ, so
      // this end-to-end case runs only when the client major matches the
      // embedded server major and a real binary exists. Not-applicable runs
      // return early (a passed test, not skipped — the spawn path itself is
      // covered deterministically by the env-stub case above).
      const clientMajor = pgDumpMajor();
      if (clientMajor === null) {
        console.warn("pg_dump binary not available: real pg_dump end-to-end case not applicable");
        return;
      }

      // Fast metadata query — cannot trip the 1 s limit itself.
      const probe = plainClient(bigConnectionString);
      const rows = await probe<{ v: number }[]>`
        SELECT current_setting('server_version_num')::int / 10000 AS v
      `;
      const serverMajor = rows[0]!.v;
      if (serverMajor !== clientMajor) {
        console.warn(
          `pg_dump major ${clientMajor} does not match server major ${serverMajor}: real pg_dump end-to-end case not applicable`,
        );
        return;
      }

      const backupDir = createTempDir("paperclip-statement-timeout-pgdump-real-");
      const result = await runDatabaseBackup({
        connectionString: bigConnectionString,
        backupDir,
        retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
        filenamePrefix: "paperclip-test",
        backupEngine: "pg_dump",
      });

      expect(fs.existsSync(result.backupFile)).toBe(true);
    },
    BIG_TEST_TIMEOUT_MS,
  );
});
