import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";


import { runDatabaseBackup, verifyBackupFile, BackupVerificationError } from "./backup-lib.js";


import { backupRetentionPolicySchema } from "@paperclipai/shared/validators/instance";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void> | void> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

// OPE-4832: a faithful stub of the tail of a real `pg_dump --format=plain`
// dump (PGDG 18.6 on the verification stand). The closing `COMMIT;` of the
// data section sits above this window (post-data/ACL blocks follow it), so
// the last 64 KiB carry only the dump-complete trailer — verification must
// accept that.
const PG_DUMP_TAIL_SAMPLE = [
  "COPY public.sessions (id, company_id) FROM stdin;",
  "\\N\t\\N",
  "\\.;",
  "",
  "--",
  "-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: -; Owner: -",
  "--",
  "",
  "ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE ALL ON SEQUENCES  FROM postgres;",
  "",
  "--",
  "-- PostgreSQL database dump complete",
  "--",
  "",
].join("\n");

async function createTempDatabase(): Promise<string> {
  const db = await startEmbeddedPostgresTestDatabase("paperclip-keep-last-backup-");
  cleanups.push(db.cleanup);
  return db.connectionString;
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
}, 60_000);

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres keep-last backup tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("backupRetentionPolicySchema keepLastOnly (BACKUP-KEEP-LAST)", () => {
  it("parses keepLastOnly: true and leaves legacy payloads unchanged", () => {
    const withFlag = backupRetentionPolicySchema.parse({
      dailyDays: 3,
      weeklyWeeks: 1,
      monthlyMonths: 1,
      keepLastOnly: true,
    });
    expect(withFlag).toEqual({
      dailyDays: 3,
      weeklyWeeks: 1,
      monthlyMonths: 1,
      keepLastOnly: true,
    });

    const legacy = backupRetentionPolicySchema.parse({});
    expect(legacy).toEqual({ dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 });
    expect("keepLastOnly" in legacy).toBe(false);

    const legacyExplicit = backupRetentionPolicySchema.parse({
      dailyDays: 14,
      weeklyWeeks: 2,
      monthlyMonths: 6,
    });
    expect(legacyExplicit).toEqual({ dailyDays: 14, weeklyWeeks: 2, monthlyMonths: 6 });
    expect("keepLastOnly" in legacyExplicit).toBe(false);
  });
});

describe("verifyBackupFile (BACKUP-KEEP-LAST)", () => {
  it("accepts a plain .sql dump ending in COMMIT;", async () => {
    const dir = createTempDir("paperclip-verify-plain-");
    const file = path.join(dir, "paperclip-test-20260101-000000.sql");
    fs.writeFileSync(file, "BEGIN;\nSELECT 1;\nCOMMIT;\n", "utf8");
    await expect(verifyBackupFile(file)).resolves.toEqual({ ok: true });
  });

  it("rejects a plain .sql dump without the closing COMMIT;", async () => {
    const dir = createTempDir("paperclip-verify-truncated-");
    const file = path.join(dir, "paperclip-test-20260101-000000.sql");
    fs.writeFileSync(file, "BEGIN;\nSELECT 1;\n", "utf8");
    const result = await verifyBackupFile(file);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/COMMIT/);
  });

  it("accepts a .sql.gz whose decompressed tail ends in COMMIT;", async () => {
    const dir = createTempDir("paperclip-verify-gz-");
    const file = path.join(dir, "paperclip-test-20260101-000000.sql.gz");
    fs.writeFileSync(file, gzipSync(Buffer.from("BEGIN;\nSELECT 1;\nCOMMIT;\n", "utf8")));
    await expect(verifyBackupFile(file)).resolves.toEqual({ ok: true });
  });

  it("rejects a corrupt .sql.gz stream", async () => {
    const dir = createTempDir("paperclip-verify-badgz-");
    const file = path.join(dir, "paperclip-test-20260101-000000.sql.gz");
    fs.writeFileSync(file, Buffer.from("not a gzip stream at all", "utf8"));
    const result = await verifyBackupFile(file);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/decompress/);
  });

  it("rejects a .sql.gz that decompresses but lacks COMMIT;", async () => {
    const dir = createTempDir("paperclip-verify-gznocommit-");
    const file = path.join(dir, "paperclip-test-20260101-000000.sql.gz");
    fs.writeFileSync(file, gzipSync(Buffer.from("BEGIN;\nSELECT 1;\n", "utf8")));
    const result = await verifyBackupFile(file);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/COMMIT/);
  });

  // OPE-4832: `pg_dump --format=plain` never ends its output with COMMIT; —
  // the last COMMIT; belongs to the final data section and the utility
  // instead closes a successful dump with the trailer comment
  // "-- PostgreSQL database dump complete". That tail must verify.
  it("accepts a real pg_dump plain tail ending in the dump-complete trailer", async () => {
    const dir = createTempDir("paperclip-verify-pgdump-tail-");
    const file = path.join(dir, "paperclip-test-20260101-000000.sql.gz");
    fs.writeFileSync(
      file,
      gzipSync(Buffer.from(PG_DUMP_TAIL_SAMPLE, "utf8")),
    );
    await expect(verifyBackupFile(file)).resolves.toEqual({ ok: true });
  });

  it("rejects a pg_dump-shaped tail truncated before the completion trailer", async () => {
    const dir = createTempDir("paperclip-verify-pgdump-trunc-");
    const file = path.join(dir, "paperclip-test-20260101-000000.sql");
    // A dump interrupted mid-COPY: no COMMIT; anywhere and no trailer.
    fs.writeFileSync(file, "COPY public.t (id) FROM stdin;\n1\n", "utf8");
    const result = await verifyBackupFile(file);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/completion marker/);
  });
});

describeEmbeddedPostgres("runDatabaseBackup keepLastOnly (BACKUP-KEEP-LAST)", () => {
  it(
    "keepLastOnly removes previous .sql.gz backups and keeps exactly the new verified one",
    async () => {
      const connectionString = await createTempDatabase();
      const backupDir = createTempDir("paperclip-keep-last-");
      const oldBackup = path.join(backupDir, "paperclip-test-20260101-000000.sql.gz");
      fs.writeFileSync(
        oldBackup,
        gzipSync(Buffer.from("BEGIN;\nSELECT 1;\nCOMMIT;\n", "utf8")),
      );
      fs.utimesSync(oldBackup, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));

      const result = await runDatabaseBackup({
        connectionString,
        backupDir,
        retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1, keepLastOnly: true },
        filenamePrefix: "paperclip-test",
      });

      expect(result.prunedCount).toBe(1);
      expect(fs.existsSync(result.backupFile)).toBe(true);
      expect(fs.existsSync(oldBackup)).toBe(false);
      const remaining = fs.readdirSync(backupDir).filter((name) => name.startsWith("paperclip-test-"));
      expect(remaining).toEqual([path.basename(result.backupFile)]);
    },
    60_000,
  );

  it(
    "a corrupt new dump fails the run, deletes only the new file and keeps the old backups",
    async () => {
      const connectionString = await createTempDatabase();
      const backupDir = createTempDir("paperclip-keep-last-corrupt-");
      const oldBackup = path.join(backupDir, "paperclip-test-20260101-000000.sql.gz");
      fs.writeFileSync(
        oldBackup,
        gzipSync(Buffer.from("BEGIN;\nSELECT 1;\nCOMMIT;\n", "utf8")),
      );
      fs.utimesSync(oldBackup, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));

      // The pg_dump engine pipes the child's stdout through gzip into the new
      // dump file, then verifies it before any deletion. A stub pg_dump that
      // emits garbage (the gzip stream is valid, but the decompressed dump has
      // no closing COMMIT; marker) deterministically lands the run in the
      // corrupt-new-dump branch: verification fails, the new file is deleted,
      // previous backups are kept.
      const stubDir = createTempDir("paperclip-pg-dump-stub-");
      const stubBin = path.join(stubDir, "pg_dump");
      fs.writeFileSync(stubBin, "#!/bin/sh\nprintf 'garbage, not a dump\\n'\nexit 0\n", { mode: 0o755 });
      const previousPgDumpPath = process.env.PAPERCLIP_PG_DUMP_PATH;
      process.env.PAPERCLIP_PG_DUMP_PATH = stubBin;
      try {
        await expect(
          runDatabaseBackup({
            connectionString,
            backupDir,
            retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1, keepLastOnly: true },
            filenamePrefix: "paperclip-test",
            backupEngine: "pg_dump",
          }),
        ).rejects.toThrow(/Backup verification failed/);
      } finally {
        if (previousPgDumpPath === undefined) delete process.env.PAPERCLIP_PG_DUMP_PATH;
        else process.env.PAPERCLIP_PG_DUMP_PATH = previousPgDumpPath;
      }

      // The corrupt new dump is dropped; the previous verified backup is kept.
      expect(fs.existsSync(oldBackup)).toBe(true);
      const remaining = fs.readdirSync(backupDir).filter((name) => name.startsWith("paperclip-test-"));
      expect(remaining).toEqual([path.basename(oldBackup)]);
    },
    60_000,
  );

  // OPE-4832: the exact live-stand repro. With a real pg_dump on PATH the
  // auto engine used to fail every keep-last run ("missing closing COMMIT;
  // marker") and then crash the JavaScript fallback on the aborted writer.
  // A faithful pg_dump tail (completion trailer, no closing COMMIT; in the
  // tail window) must now verify, prune the old backups, and return the new
  // file — on the pg_dump engine, without any fallback.
  it(
    "a real-shaped pg_dump plain stub passes verification, creates the backup and prunes the old one",
    async () => {
      const connectionString = await createTempDatabase();
      const backupDir = createTempDir("paperclip-keep-last-pgdump-ok-");
      const oldBackup = path.join(backupDir, "paperclip-test-20260101-000000.sql.gz");
      fs.writeFileSync(
        oldBackup,
        gzipSync(Buffer.from("BEGIN;\nSELECT 1;\nCOMMIT;\n", "utf8")),
      );
      fs.utimesSync(oldBackup, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));

      const stubDir = createTempDir("paperclip-pg-dump-stub-ok-");
      const dumpBody = path.join(stubDir, "dump.sql");
      fs.writeFileSync(dumpBody, PG_DUMP_TAIL_SAMPLE, "utf8");
      const stubBin = path.join(stubDir, "pg_dump");
      fs.writeFileSync(stubBin, `#!/bin/sh\ncat ${dumpBody}\nexit 0\n`, { mode: 0o755 });
      const previousPgDumpPath = process.env.PAPERCLIP_PG_DUMP_PATH;
      process.env.PAPERCLIP_PG_DUMP_PATH = stubBin;
      try {
        const result = await runDatabaseBackup({
          connectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1, keepLastOnly: true },
          filenamePrefix: "paperclip-test",
        });
        // The run completed on the pg_dump path: the verified new dump is the
        // only file left.
        expect(fs.existsSync(result.backupFile)).toBe(true);
        expect(fs.existsSync(oldBackup)).toBe(false);
        expect(result.prunedCount).toBe(1);
        const remaining = fs.readdirSync(backupDir).filter((name) => name.startsWith("paperclip-test-"));
        expect(remaining).toEqual([path.basename(result.backupFile)]);
      } finally {
        if (previousPgDumpPath === undefined) delete process.env.PAPERCLIP_PG_DUMP_PATH;
        else process.env.PAPERCLIP_PG_DUMP_PATH = previousPgDumpPath;
      }
    },
    60_000,
  );

  // OPE-4832 fact 2: a corrupt dump under the auto engine must NOT be retried
  // on JavaScript (that used to surface as "Cannot write to closed backup
  // file" on the already-aborted writer and hid the real reason). The run
  // fails loudly with the verification reason, the corrupt file is dropped
  // and the previous backups stay untouched.
  it(
    "engine auto with a corrupt pg_dump output fails as a verification error without falling back",
    async () => {
      const connectionString = await createTempDatabase();
      const backupDir = createTempDir("paperclip-keep-last-pgdump-bad-");
      const oldBackup = path.join(backupDir, "paperclip-test-20260101-000000.sql.gz");
      fs.writeFileSync(
        oldBackup,
        gzipSync(Buffer.from("BEGIN;\nSELECT 1;\nCOMMIT;\n", "utf8")),
      );
      fs.utimesSync(oldBackup, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));

      const stubDir = createTempDir("paperclip-pg-dump-stub-bad-");
      const stubBin = path.join(stubDir, "pg_dump");
      fs.writeFileSync(stubBin, "#!/bin/sh\nprintf 'garbage, not a dump\\n'\nexit 0\n", { mode: 0o755 });
      const previousPgDumpPath = process.env.PAPERCLIP_PG_DUMP_PATH;
      process.env.PAPERCLIP_PG_DUMP_PATH = stubBin;
      try {
        // The run must fail with the verification error itself — not a
        // closed-writer crash from a JavaScript fallback.
        const error = await runDatabaseBackup({
          connectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1, keepLastOnly: true },
          filenamePrefix: "paperclip-test",
          // auto (not pg_dump): this is the engine that used to fall through
          // to JavaScript on the closed writer.
        }).then(
          () => null,
          (caught: unknown) => caught,
        );
        expect(error).toBeInstanceOf(BackupVerificationError);
        expect(String(error)).toMatch(/Backup verification failed/);
        expect(String(error)).not.toMatch(/closed backup file/);
      } finally {
        if (previousPgDumpPath === undefined) delete process.env.PAPERCLIP_PG_DUMP_PATH;
        else process.env.PAPERCLIP_PG_DUMP_PATH = previousPgDumpPath;
      }
      // The corrupt new dump is dropped; the previous backup is kept.
      expect(fs.existsSync(oldBackup)).toBe(true);
      const remaining = fs.readdirSync(backupDir).filter((name) => name.startsWith("paperclip-test-"));
      expect(remaining).toEqual([path.basename(oldBackup)]);
    },
    60_000,
  );

  // A genuine pg_dump failure (non-zero exit) still falls back to JavaScript,
  // and the fallback now writes into a freshly opened writer instead of the
  // aborted one.
  it(
    "engine auto falls back to JavaScript when the pg_dump child itself fails",
    async () => {
      const connectionString = await createTempDatabase();
      const backupDir = createTempDir("paperclip-keep-last-pgdump-crash-");

      const stubDir = createTempDir("paperclip-pg-dump-stub-crash-");
      const stubBin = path.join(stubDir, "pg_dump");
      fs.writeFileSync(stubBin, "#!/bin/sh\nprintf 'pg_dump: error: simulated crash\\n' >&2\nexit 1\n", { mode: 0o755 });
      const previousPgDumpPath = process.env.PAPERCLIP_PG_DUMP_PATH;
      process.env.PAPERCLIP_PG_DUMP_PATH = stubBin;
      try {
        const result = await runDatabaseBackup({
          connectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1, keepLastOnly: true },
          filenamePrefix: "paperclip-test",
        });
        // The JavaScript engine wrote and verified a complete dump.
        expect(fs.existsSync(result.backupFile)).toBe(true);
        await expect(verifyBackupFile(result.backupFile)).resolves.toEqual({ ok: true });
      } finally {
        if (previousPgDumpPath === undefined) delete process.env.PAPERCLIP_PG_DUMP_PATH;
        else process.env.PAPERCLIP_PG_DUMP_PATH = previousPgDumpPath;
      }
    },
    60_000,
  );

  it(
    "keepLastOnly prunes an orphaned unfinished .sql older than 1h and counts it in prunedCount",
    async () => {
      const connectionString = await createTempDatabase();
      const backupDir = createTempDir("paperclip-keep-last-orphan-mode-");
      const staleOrphan = path.join(backupDir, "paperclip-test-20260101-000000.sql");
      fs.writeFileSync(staleOrphan, "BEGIN;\n-- never finished\n", "utf8");
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      fs.utimesSync(staleOrphan, twoHoursAgo, twoHoursAgo);

      const result = await runDatabaseBackup({
        connectionString,
        backupDir,
        retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1, keepLastOnly: true },
        filenamePrefix: "paperclip-test",
      });

      // The orphan pass runs in keep-last mode too: the stale .sql is removed
      // and counted, the fresh verified dump is the only file left.
      expect(result.prunedCount).toBe(1);
      expect(fs.existsSync(staleOrphan)).toBe(false);
      expect(fs.existsSync(result.backupFile)).toBe(true);
      const remaining = fs.readdirSync(backupDir).filter((name) => name.startsWith("paperclip-test-"));
      expect(remaining).toEqual([path.basename(result.backupFile)]);
    },
    60_000,
  );

  it(
    "orphan cleanup removes an unfinished .sql older than 1h and spares the live one",
    async () => {
      const connectionString = await createTempDatabase();
      const backupDir = createTempDir("paperclip-keep-last-orphan-");
      const staleOrphan = path.join(backupDir, "paperclip-test-20260101-000000.sql");
      fs.writeFileSync(staleOrphan, "BEGIN;\n-- never finished\n", "utf8");
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      fs.utimesSync(staleOrphan, twoHoursAgo, twoHoursAgo);

      const result = await runDatabaseBackup({
        connectionString,
        backupDir,
        retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
        filenamePrefix: "paperclip-test",
      });

      expect(result.prunedCount).toBe(1);
      expect(fs.existsSync(staleOrphan)).toBe(false);
      expect(fs.existsSync(result.backupFile)).toBe(true);
      // The live run's own .sql was already gzipped away; nothing plain remains.
      const plainLeftovers = fs
        .readdirSync(backupDir)
        .filter((name) => name.startsWith("paperclip-test-") && name.endsWith(".sql"));
      expect(plainLeftovers).toEqual([]);
    },
    60_000,
  );
});
