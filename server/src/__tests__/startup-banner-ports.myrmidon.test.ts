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
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("startup banner port diagnostics", () => {
  it.each([
    { requestedPort: 3100, listenPort: 3100, server: "3100", api: "http://localhost:3100/api (health: http://localhost:3100/api/health)", ui: "http://localhost:3100" },
    { requestedPort: 3100, listenPort: 3101, server: "3101 (requested 3100)", api: "http://localhost:3101/api (health: http://localhost:3101/api/health)", ui: "http://localhost:3101" },
    { requestedPort: 0, listenPort: 43210, server: "43210 (requested 0)", api: "http://localhost:43210/api (health: http://localhost:43210/api/health)", ui: "http://localhost:43210" },
    { requestedPort: 0, listenPort: 0, server: "0", api: "http://localhost:0/api (health: http://localhost:0/api/health)", ui: "http://localhost:0" },
  ])("reports actual port for requested=$requestedPort and listen=$listenPort", ({ requestedPort, listenPort, server, api, ui }) => {
    vi.stubEnv("MYRMIDON_AGENT_JWT_SECRET", "");
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const opts: Parameters<typeof printStartupBanner>[0] = {
      bind: "loopback",
      host: "0.0.0.0",
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      requestedPort,
      listenPort,
      uiMode: "static",
      db: { mode: "embedded-postgres", dataDir: "/fixture/db", port: 5432 },
      migrationSummary: "none",
      heartbeatSchedulerEnabled: false,
      heartbeatSchedulerIntervalMs: 1000,
      databaseBackupEnabled: false,
      databaseBackupIntervalMinutes: 60,
      databaseBackupRetentionDays: 7,
      databaseBackupDir: "/fixture/backup",
    };

    printStartupBanner(opts);

    expect(log).toHaveBeenCalledTimes(1);
    const output = String(log.mock.calls[0][0]).replace(/\x1b\[[0-9;]*m/g, "");
    const rows = output.split("\n");
    for (const [name, expected] of [["Server", server], ["API", api], ["UI", ui]]) {
      const matching = rows.filter((line) => line.startsWith(`${name} `));
      expect(matching).toHaveLength(1);
      expect(matching[0].slice(17)).toBe(expected);
    }
  });
});
