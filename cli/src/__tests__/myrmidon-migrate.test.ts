import { describe, expect, it } from "vitest";
import { inventoryDirectory, myrmidonMigrateCommand } from "../commands/myrmidon-migrate.js";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
      })).rejects.toThrow(/intentionally unavailable/);
      expect(await readdir(target)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
