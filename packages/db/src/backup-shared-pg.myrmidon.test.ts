import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  BackupClientVersionError,
  diagnosePgDumpClient,
  formatDatabaseBackupResult,
  parsePgMajorVersion,
  runDatabaseBackup,
} from "./backup-lib.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

// myrmidon(SHARED-PG-BACKUP): the board's database may live on a shared
// PostgreSQL 18 server while the host ships older client tools (pg_dump 17).
// The dump path is configured through the instance connection string and
// PAPERCLIP_PG_DUMP_PATH — never through a hardcoded container — and a client
// older than the server major must be diagnosed before the dump, not die
// mid-spawn with an unclear libpq error.

const cleanups: Array<() => Promise<void> | void> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const originalPgDumpPath = process.env.PAPERCLIP_PG_DUMP_PATH;

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

async function createTempDatabase(): Promise<string> {
  const db = await startEmbeddedPostgresTestDatabase("paperclip-shared-pg-backup-");
  cleanups.push(db.cleanup);
  return db.connectionString;
}

// A stub client binary that only answers `--version`, so the diagnosis can be
// asserted on hosts without any real pg_dump (the embedded Postgres package
// ships no client tools). `major` is the version the stub reports.
function writeClientVersionStub(major: string): string {
  const dir = createTempDir(`paperclip-pgdump-${major}-stub-`);
  const bin = path.join(dir, "pg_dump");
  fs.writeFileSync(
    bin,
    ["#!/bin/sh", `if [ "$1" = "--version" ]; then echo "pg_dump (PostgreSQL) ${major}"; exit 0; fi`, "exit 1", ""].join("\n"),
    { mode: 0o755 },
  );
  return bin;
}

afterEach(() => {
  if (originalPgDumpPath === undefined) delete process.env.PAPERCLIP_PG_DUMP_PATH;
  else process.env.PAPERCLIP_PG_DUMP_PATH = originalPgDumpPath;
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    void cleanup?.();
  }
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres shared-server backup tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("parsePgMajorVersion (SHARED-PG-BACKUP)", () => {
  it("reads the major of server version() and client --version outputs", () => {
    expect(parsePgMajorVersion("PostgreSQL 18.1 on x86_64-pc-linux-gnu")).toBe(18);
    expect(parsePgMajorVersion("PostgreSQL 17.6")).toBe(17);
    expect(
      parsePgMajorVersion("pg_dump (PostgreSQL) 17.6 (Ubuntu 17.6-0.pgdg22.04+1)"),
    ).toBe(17);
    expect(parsePgMajorVersion("pg_dump (PostgreSQL) 18.6")).toBe(18);
    expect(parsePgMajorVersion("not a version")).toBeNull();
    // CI regression: a stub client answering --version with its dump body
    // must not be read as major 1 — only real major.minor shapes count.
    expect(parsePgMajorVersion("SELECT 1;")).toBeNull();
    expect(parsePgMajorVersion("pg_dump (PostgreSQL) 1")).toBeNull();
  });
});

describe("diagnosePgDumpClient (SHARED-PG-BACKUP)", () => {
  it("reports an older client against a newer server with the fix in the message", async () => {
    const issue = await diagnosePgDumpClient(writeClientVersionStub("17.6"), 18);
    expect(issue).toContain("pg_dump client is PostgreSQL major 17");
    expect(issue).toContain("server is major 18");
    expect(issue).toContain("PAPERCLIP_PG_DUMP_PATH");
  });

  it("passes when the client major matches or leads the server major", async () => {
    expect(await diagnosePgDumpClient(writeClientVersionStub("18.1"), 18)).toBeNull();
    expect(await diagnosePgDumpClient(writeClientVersionStub("19.0"), 18)).toBeNull();
  });

  it("stays silent when the client cannot be asked (missing binary, broken stub)", async () => {
    const missing = path.join(createTempDir("paperclip-pgdump-missing-"), "pg_dump");
    expect(await diagnosePgDumpClient(missing, 18)).toBeNull();
    // A binary that fails --version is left to the real dump, as before.
    const broken = path.join(createTempDir("paperclip-pgdump-broken-"), "pg_dump");
    fs.writeFileSync(broken, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    expect(await diagnosePgDumpClient(broken, 18)).toBeNull();
  });
});

describe("formatDatabaseBackupResult warnings surface (SHARED-PG-BACKUP)", () => {
  it("includes every non-fatal warning in the one-line summary", () => {
    const clean = formatDatabaseBackupResult({ backupFile: "/tmp/a.sql.gz", sizeBytes: 10, prunedCount: 0 });
    expect(clean).not.toContain("warning");
    const warned = formatDatabaseBackupResult({
      backupFile: "/tmp/a.sql.gz",
      sizeBytes: 10,
      prunedCount: 0,
      warnings: ["pg_dump client is older than the server"],
    });
    expect(warned).toContain("warning: pg_dump client is older than the server");
  });
});

describeEmbeddedPostgres("runDatabaseBackup against a newer server (SHARED-PG-BACKUP)", () => {
  it(
    "engine 'pg_dump' fails with a clear version error before running the dump",
    async () => {
      const connectionString = await createTempDatabase();
      process.env.PAPERCLIP_PG_DUMP_PATH = writeClientVersionStub("17.6");
      const backupDir = createTempDir("paperclip-shared-pg-pgdump-");
      await expect(
        runDatabaseBackup({
          connectionString,
          backupDir,
          retention: { dailyDays: 1, weeklyWeeks: 1, monthlyMonths: 1 },
          filenamePrefix: "paperclip-shared-pg-test",
          backupEngine: "pg_dump",
        }),
      ).rejects.toBeInstanceOf(BackupClientVersionError);
      // nothing of the failed run is left behind
      expect(fs.readdirSync(backupDir)).toEqual([]);
    },
    120_000,
  );

  it(
    "engine 'auto' warns about the older client and still produces the dump through the JavaScript path",
    async () => {
      const connectionString = await createTempDatabase();
      process.env.PAPERCLIP_PG_DUMP_PATH = writeClientVersionStub("17.6");
      const backupDir = createTempDir("paperclip-shared-pg-auto-");
      const result = await runDatabaseBackup({
        connectionString,
        backupDir,
        retention: { dailyDays: 1, weeklyWeeks: 1, monthlyMonths: 1 },
        filenamePrefix: "paperclip-shared-pg-test",
      });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings?.[0]).toContain("pg_dump client is PostgreSQL major 17");
      expect(result.sizeBytes).toBeGreaterThan(0);
      expect(result.backupFile.endsWith(".sql.gz")).toBe(true);
      expect(fs.existsSync(result.backupFile)).toBe(true);
    },
    120_000,
  );
});
