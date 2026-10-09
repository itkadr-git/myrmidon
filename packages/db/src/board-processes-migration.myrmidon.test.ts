// myrmidon(PROCS-0.1): the board_processes migration shape and the pulse
// upsert SQL, without a database. The embedded-pg coverage of migrations
// lives in the migration runner suite; here the DDL stays aligned with the
// schema the service writes through.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const migrationSql = readFileSync(
  fileURLToPath(new URL("./migrations/0311_board_processes.sql", import.meta.url)),
  "utf8",
);

describe("board_processes migration (PROCS-0.1)", () => {
  it("creates the table with every column the ticket names", () => {
    expect(migrationSql).toContain('CREATE TABLE IF NOT EXISTS "board_processes"');
    for (const column of [
      "boot_id",
      "role",
      "pid",
      "hostname",
      "container",
      "version",
      "started_at",
      "last_seen_at",
      "api_port",
      "event_loop_lag_ms",
      "rss_bytes",
    ]) {
      expect(migrationSql, `column ${column}`).toContain(`"${column}"`);
    }
  });

  it("keys the table on boot_id and indexes the pulse sweep", () => {
    expect(migrationSql).toContain("PRIMARY KEY");
    expect(migrationSql).toContain("board_processes_last_seen_idx");
  });

  it("is a plain forward DDL (no transaction directives)", () => {
    expect(migrationSql).not.toMatch(/BEGIN|COMMIT/i);
  });
});
