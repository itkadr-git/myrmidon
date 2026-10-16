import { describe, expect, it } from "vitest";
import { inventoryDirectory, myrmidonMigrateCommand } from "../commands/myrmidon-migrate.js";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { verifyJournalHash, verifyPgDumpMigrationChain } from "../commands/myrmidon-migrate-compatibility.js";
import supportedJournal from "../../../packages/db/src/migrations/meta/_journal.json" with { type: "json" };

describe("myrmidon:migrate safety contract", () => {
  it("requires exactly one source and an explicit target", async () => {
    await expect(myrmidonMigrateCommand({ dryRun: true, targetDir: "/unused" })).rejects.toThrow(/Exactly one source/);
    await expect(myrmidonMigrateCommand({ dryRun: true, sourceDump: "dump.sql" })).rejects.toThrow(/target is required/);
  });

  it("never allows execution without the compatibility protocol", async () => {
    await expect(myrmidonMigrateCommand({ sourceDump: "missing.sql", targetDir: "/unused" })).rejects.toThrow();
  });

  it("hashes regular files and refuses symlinks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "myrmidon-migrate-"));
    try {
      await writeFile(path.join(root, "data.txt"), "fixture");
      expect(await inventoryDirectory(root)).toMatchObject([{ path: "data.txt", sizeBytes: 7 }]);
      await symlink(path.join(root, "data.txt"), path.join(root, "linked.txt"));
      await expect(inventoryDirectory(root)).rejects.toThrow(/symlink/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not treat missing targets as an invitation to mutate", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "myrmidon-migrate-target-"));
    try {
      const target = path.join(root, "target");
      await mkdir(target);
      await writeFile(path.join(root, "dump.sql"), "-- fixture");
      await expect(myrmidonMigrateCommand({
        sourceDump: path.join(root, "dump.sql"), targetDir: target,
      })).rejects.toThrow(/exactly one Drizzle migration journal record/);
      expect(await readdir(target)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unsupported and altered chains before any target work", () => {
    expect(() => verifyJournalHash({ ...supportedJournal, version: "8" })).toThrow(/version/);
    expect(() => verifyJournalHash({ ...supportedJournal, entries: supportedJournal.entries.slice(0, -1) })).toThrow(/exact full journal/);
    const altered = structuredClone(supportedJournal);
    altered.entries[100].tag = "0100_tampered";
    expect(() => verifyJournalHash(altered)).toThrow(/exact full journal/);
  });

  it("accepts exact journal payloads in pg_dump INSERT and COPY formats", () => {
    verifyJournalHash(supportedJournal);
    const journal = JSON.stringify(supportedJournal);
    const escapedJournal = journal.replace(/'/g, "''");
    const insert = `INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (1, '${escapedJournal}', 1789390281190);`;
    const copy = `COPY drizzle.__drizzle_migrations (id, hash, created_at) FROM stdin;\n1\t${journal}\t1789390281190\n\\.\n`;
    expect(verifyPgDumpMigrationChain(insert)).toMatchObject({ version: "7" });
    expect(verifyPgDumpMigrationChain(copy)).toMatchObject({ version: "7" });
    expect(() => verifyPgDumpMigrationChain(insert.replace(escapedJournal, "{}"))).toThrow();
    expect(() => verifyPgDumpMigrationChain(copy.replace(journal, "{}"))).toThrow();
    expect(() => verifyPgDumpMigrationChain(`${insert}\n${insert}`)).toThrow(/exactly one/);
  });
});
