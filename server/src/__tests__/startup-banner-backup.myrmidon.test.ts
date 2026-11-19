import { afterEach, describe, expect, it, vi } from "vitest";
import { printStartupBanner } from "../startup-banner.js";

vi.mock("../paths.js", () => ({
  resolvePaperclipConfigPath: () => "/fixture/config.json",
  resolvePaperclipEnvPath: () => "/fixture/.env",
}));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: vi.fn(() => false),
}));

type Options = Parameters<typeof printStartupBanner>[0];

const options: Options = {
  bind: "loopback",
  host: "localhost",
  deploymentMode: "local_trusted",
  deploymentExposure: "private",
  authReady: true,
  requestedPort: 3100,
  listenPort: 3100,
  uiMode: "none",
  db: { mode: "embedded-postgres", dataDir: "/fixture/first-data", port: 5433 },
  migrationSummary: "current",
  heartbeatSchedulerEnabled: false,
  heartbeatSchedulerIntervalMs: 1000,
  databaseBackupEnabled: true,
  databaseBackupIntervalMinutes: 37,
  databaseBackupRetentionDays: 12,
  databaseBackupDir: "/fixture/first-backup",
};

function row(output: string, label: string): string {
  const lines = output.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
  const matches = lines.filter((line) => line.startsWith(label.padEnd(16) + " "));
  expect(matches).toHaveLength(1);
  return matches[0]!.slice(17);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("startup banner embedded database and backups", () => {
  it("prints the embedded database and enabled backup policy", () => {
    vi.stubEnv("MYRMIDON_AGENT_JWT_SECRET", "");
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    printStartupBanner(options);
    expect(log).toHaveBeenCalledTimes(1);
    const output = String(log.mock.calls[0]![0]);
    expect(row(output, "Mode")).toBe("embedded-postgres  |  headless-api");
    expect(row(output, "Database")).toBe("/fixture/first-data (pg:5433)");
    expect(row(output, "DB Backup")).toBe("enabled (every 37m, keep 12d)");
    expect(row(output, "Backup Dir")).toBe("/fixture/first-backup");
  });

  it("uses each call's paths and port and omits the disabled policy", () => {
    vi.stubEnv("MYRMIDON_AGENT_JWT_SECRET", "");
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    printStartupBanner(options);
    printStartupBanner({
      ...options,
      db: { mode: "embedded-postgres", dataDir: "/fixture/second-data", port: 6544 },
      databaseBackupEnabled: false,
      databaseBackupDir: "/fixture/second-backup",
    });
    expect(log).toHaveBeenCalledTimes(2);
    const first = String(log.mock.calls[0]![0]);
    const second = String(log.mock.calls[1]![0]);
    expect(row(first, "Database")).toBe("/fixture/first-data (pg:5433)");
    expect(row(first, "DB Backup")).toBe("enabled (every 37m, keep 12d)");
    expect(row(first, "Backup Dir")).toBe("/fixture/first-backup");
    expect(row(second, "Mode")).toBe("embedded-postgres  |  headless-api");
    expect(row(second, "Database")).toBe("/fixture/second-data (pg:6544)");
    expect(row(second, "DB Backup")).toBe("disabled");
    expect(row(second, "Backup Dir")).toBe("/fixture/second-backup");
  });
});
