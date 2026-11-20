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

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("startup banner endpoints", () => {
  it.each([
    ["0.0.0.0", "http://localhost:4321/api", "http://localhost:4321/api/health"],
    ["localhost", "http://localhost:4321/api", "http://localhost:4321/api/health"],
    ["127.0.0.1", "http://127.0.0.1:4321/api", "http://127.0.0.1:4321/api/health"],
    ["example.invalid", "http://example.invalid:4321/api", "http://example.invalid:4321/api/health"],
  ])("prints the API and health endpoints for %s", (host, api, health) => {
    vi.stubEnv("MYRMIDON_AGENT_JWT_SECRET", "");
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const opts: Parameters<typeof printStartupBanner>[0] = {
      bind: "loopback",
      host,
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      requestedPort: 3100,
      listenPort: 4321,
      uiMode: "none",
      db: { mode: "embedded-postgres", dataDir: "/fixture/db", port: 5432 },
      migrationSummary: "ready",
      heartbeatSchedulerEnabled: false,
      heartbeatSchedulerIntervalMs: 1000,
      databaseBackupEnabled: false,
      databaseBackupIntervalMinutes: 60,
      databaseBackupRetentionDays: 7,
      databaseBackupDir: "/fixture/backups",
    };

    printStartupBanner(opts);

    expect(log).toHaveBeenCalledTimes(1);
    const output = String(log.mock.calls[0][0]).replace(/\x1b\[[0-9;]*m/g, "");
    const apiRows = output.split("\n").filter((line) => /^API\s/.test(line));
    expect(apiRows).toEqual([`API              ${api} (health: ${health})`]);
  });
});
