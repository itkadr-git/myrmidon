import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as prompts from "@clack/prompts";

vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn(() => false),
  log: { message: vi.fn(), warn: vi.fn(), step: vi.fn(), error: vi.fn() },
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  text: vi.fn(),
  select: vi.fn(),
  multiselect: vi.fn(),
}));

// myrmidon(SHARED-PG-BACKUP): the backup command must dump the instance's
// own database through the configured connection — never a hardcoded
// container — and must surface the engine's client-version warnings.
vi.mock("@paperclipai/db", () => ({
  formatDatabaseBackupResult: vi.fn((result: { backupFile: string }) => result.backupFile),
  runDatabaseBackup: vi.fn(async () => ({
    backupFile: "/backups/paperclip-2026-10-07.sql.gz",
    sizeBytes: 42,
    prunedCount: 0,
    warnings: ["pg_dump client is PostgreSQL major 17 but the server is major 18"],
  })),
}));

import { formatDatabaseBackupResult, runDatabaseBackup } from "@paperclipai/db";
import { dbBackupCommand } from "../commands/db-backup.js";

const CONNECTION_STRING = "postgres://board_role:board-pass@pg-shared.example:5432/board_db";

function writeTempConfig(body: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-backup-test-"));
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(body, null, 2) + "\n");
  return configPath;
}

function baseConfig(database: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    $meta: {
      version: 1,
      updatedAt: "2026-10-07T00:00:00.000Z",
      source: "configure",
    },
    database: { mode: "embedded-postgres", ...database },
    logging: { mode: "file" },
    server: {},
  };
}

describe("db:backup command (SHARED-PG-BACKUP)", () => {
  const envKeys = ["PAPERCLIP_CONFIG", "DATABASE_URL", "PAPERCLIP_INSTANCE_ID", "PAPERCLIP_HOME"];
  const savedEnv: Record<string, string | undefined> = {};
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const key of envKeys) savedEnv[key] = process.env[key];
    delete process.env.DATABASE_URL;
    delete process.env.PAPERCLIP_INSTANCE_ID;
    delete process.env.PAPERCLIP_HOME;
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    for (const key of envKeys) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    consoleLogSpy.mockRestore();
  });

  it("dumps the shared-server database configured for the instance, not a container", async () => {
    const configPath = writeTempConfig(
      baseConfig({ mode: "postgres", connectionString: CONNECTION_STRING, backup: { dir: "/tmp/paperclip-db-backup-test-backups", retentionDays: 5 } }),
    );
    process.env.PAPERCLIP_CONFIG = configPath;

    await dbBackupCommand({ config: configPath });

    expect(runDatabaseBackup).toHaveBeenCalledTimes(1);
    const args = vi.mocked(runDatabaseBackup).mock.calls[0]?.[0];
    expect(args?.connectionString).toBe(CONNECTION_STRING);
    expect(JSON.stringify(args)).not.toMatch(/paperclip-db-1|docker|compose/);
    expect(vi.mocked(prompts.log.message)).toHaveBeenCalledWith(
      expect.stringContaining("Connection source: config.database.connectionString"),
    );
  });

  it("prefers DATABASE_URL over the config file", async () => {
    const configPath = writeTempConfig(
      baseConfig({ mode: "postgres", connectionString: CONNECTION_STRING }),
    );
    process.env.PAPERCLIP_CONFIG = configPath;
    process.env.DATABASE_URL = "postgres://env_role:env-pass@pg-shared.example:5432/env_db";

    await dbBackupCommand({ config: configPath });

    const args = vi.mocked(runDatabaseBackup).mock.calls[0]?.[0];
    expect(args?.connectionString).toBe("postgres://env_role:env-pass@pg-shared.example:5432/env_db");
  });

  it("surfaces engine client-version warnings in the CLI output and --json", async () => {
    const configPath = writeTempConfig(
      baseConfig({ mode: "postgres", connectionString: CONNECTION_STRING }),
    );
    process.env.PAPERCLIP_CONFIG = configPath;

    await dbBackupCommand({ config: configPath, json: true });

    expect(prompts.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("pg_dump client is PostgreSQL major 17"),
    );
    const jsonOutput = consoleLogSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    const parsed = JSON.parse(jsonOutput.slice(jsonOutput.indexOf("{"))) as Record<string, unknown>;
    expect(parsed.backupFile).toBe("/backups/paperclip-2026-10-07.sql.gz");
    expect(parsed.warnings).toEqual([expect.stringContaining("major 17")]);
    expect(vi.mocked(formatDatabaseBackupResult).mock.calls[0]?.[0]).toMatchObject({
      warnings: [expect.stringContaining("major 17")],
    });
  });
});
