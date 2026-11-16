import { afterEach, describe, expect, it, vi } from "vitest";
import { printStartupBanner } from "../startup-banner.js";

vi.mock("../paths.js", () => ({
  resolvePaperclipConfigPath: () => "/synthetic/config.json",
  resolvePaperclipEnvPath: () => "/synthetic/.env",
}));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: vi.fn(() => false),
}));

type Options = Parameters<typeof printStartupBanner>[0];
const options: Options = {
  bind: "loopback",
  host: "127.0.0.1",
  deploymentMode: "local_trusted",
  deploymentExposure: "private",
  authReady: true,
  requestedPort: 3100,
  listenPort: 3100,
  uiMode: "none",
  db: { mode: "embedded-postgres", dataDir: "/synthetic/db", port: 5432 },
  migrationSummary: "ready",
  heartbeatSchedulerEnabled: true,
  heartbeatSchedulerIntervalMs: 1,
  databaseBackupEnabled: false,
  databaseBackupIntervalMinutes: 30,
  databaseBackupRetentionDays: 7,
  databaseBackupDir: "/synthetic/backup",
};

function heartbeatRow(output: string): string[] {
  return output.replace(/\x1b\[[0-9;]*m/g, "").split("\n")
    .filter((line) => /^Heartbeat\s/.test(line))
    .map((line) => line.trim());
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("startup banner heartbeat", () => {
  it.each([
    { enabled: true, interval: 1, backup: false, expected: "Heartbeat        enabled (1ms)" },
    { enabled: true, interval: 1500, backup: true, expected: "Heartbeat        enabled (1500ms)" },
    { enabled: true, interval: 12345, backup: false, expected: "Heartbeat        enabled (12345ms)" },
    { enabled: true, interval: 1500, backup: false, expected: "Heartbeat        enabled (1500ms)" },
    { enabled: false, interval: 1, backup: false, expected: "Heartbeat        disabled" },
    { enabled: false, interval: 1500, backup: true, expected: "Heartbeat        disabled" },
    { enabled: false, interval: 1500, backup: false, expected: "Heartbeat        disabled" },
  ])("prints the exact heartbeat row for $enabled / $interval / backup $backup", ({ enabled, interval, backup, expected }) => {
    vi.stubEnv("MYRMIDON_AGENT_JWT_SECRET", "");
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    printStartupBanner({ ...options, heartbeatSchedulerEnabled: enabled, heartbeatSchedulerIntervalMs: interval, databaseBackupEnabled: backup });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]).toHaveLength(1);
    expect(heartbeatRow(String(log.mock.calls[0][0]))).toEqual([expected]);
  });

  it("does not retain heartbeat state between opposite calls", () => {
    vi.stubEnv("MYRMIDON_AGENT_JWT_SECRET", "");
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    printStartupBanner({ ...options, heartbeatSchedulerEnabled: true, heartbeatSchedulerIntervalMs: 1500, databaseBackupEnabled: false });
    printStartupBanner({ ...options, heartbeatSchedulerEnabled: false, heartbeatSchedulerIntervalMs: 1, databaseBackupEnabled: true });
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.map((call) => call.length)).toEqual([1, 1]);
    expect(heartbeatRow(String(log.mock.calls[0][0]))).toEqual(["Heartbeat        enabled (1500ms)"]);
    expect(heartbeatRow(String(log.mock.calls[1][0]))).toEqual(["Heartbeat        disabled"]);
  });
});
