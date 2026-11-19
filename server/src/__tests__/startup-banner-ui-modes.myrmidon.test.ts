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

describe("startup banner UI modes", () => {
  it.each([
    { uiMode: "none", mode: "headless-api", ui: "disabled" },
    { uiMode: "static", mode: "static-ui", ui: "http://localhost:4321" },
    { uiMode: "vite-dev", mode: "vite-dev-middleware", ui: "http://localhost:4321" },
  ] as const)("reports $uiMode endpoints", ({ uiMode, mode, ui }) => {
    vi.stubEnv("MYRMIDON_AGENT_JWT_SECRET", "");
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const opts: Parameters<typeof printStartupBanner>[0] = {
      bind: "loopback",
      host: "0.0.0.0",
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      requestedPort: 4321,
      listenPort: 4321,
      uiMode,
      db: { mode: "embedded-postgres", dataDir: "/fixture/db", port: 5432 },
      migrationSummary: "up to date",
      heartbeatSchedulerEnabled: false,
      heartbeatSchedulerIntervalMs: 1000,
      databaseBackupEnabled: false,
      databaseBackupIntervalMinutes: 60,
      databaseBackupRetentionDays: 7,
      databaseBackupDir: "/fixture/backups",
    };

    printStartupBanner(opts);

    expect(log).toHaveBeenCalledOnce();
    const output = String(log.mock.calls[0][0]).replace(/\x1b\[[0-9;]*m/g, "");
    const lines = output.split("\n");
    const row = (label: string) => {
      const matches = lines.filter((line) => line.startsWith(`${label} `));
      expect(matches).toHaveLength(1);
      return matches[0].slice(label.length).trim();
    };
    expect(row("Mode")).toBe(`embedded-postgres  |  ${mode}`);
    expect(row("UI")).toBe(ui);
    expect(row("API")).toBe("http://localhost:4321/api (health: http://localhost:4321/api/health)");
  });
});
