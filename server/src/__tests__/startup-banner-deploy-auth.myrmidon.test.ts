import { afterEach, describe, expect, it, vi } from "vitest";
import { BIND_MODES, DEPLOYMENT_EXPOSURES, DEPLOYMENT_MODES } from "@myrmidon/shared";
import { printStartupBanner } from "../startup-banner.js";

vi.mock("../paths.js", () => ({
  resolvePaperclipConfigPath: () => "/fixture/config.json",
  resolvePaperclipEnvPath: () => "/fixture/missing.env",
}));
vi.mock("node:fs", () => ({
  existsSync: () => false,
  readFileSync: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("startup banner deployment, bind and auth diagnostics", () => {
  for (const deploymentMode of DEPLOYMENT_MODES) {
    for (const deploymentExposure of DEPLOYMENT_EXPOSURES) {
      for (const bind of BIND_MODES) {
        for (const authReady of [false, true]) {
          it(`${deploymentMode} / ${deploymentExposure} / ${bind} / auth=${authReady}`, () => {
            const opts: Parameters<typeof printStartupBanner>[0] = {
              deploymentMode,
              deploymentExposure,
              bind,
              host: "192.0.2.42",
              authReady,
              requestedPort: 3100,
              listenPort: 3100,
              uiMode: "none",
              db: { mode: "embedded-postgres", dataDir: "/fixture/db", port: 5432 },
              migrationSummary: "current",
              heartbeatSchedulerEnabled: false,
              heartbeatSchedulerIntervalMs: 1000,
              databaseBackupEnabled: false,
              databaseBackupIntervalMinutes: 60,
              databaseBackupRetentionDays: 7,
              databaseBackupDir: "/fixture/backup",
            };
            const otherMode = deploymentMode === "authenticated" ? "local_trusted" : "authenticated";
            const otherExposure = deploymentExposure === "public" ? "private" : "public";
            const otherBind = bind === "loopback" ? "lan" : "loopback";
            for (const prefix of ["MYRMIDON", "PAPERCLIP"]) {
              vi.stubEnv(`${prefix}_DEPLOYMENT_MODE`, otherMode);
              vi.stubEnv(`${prefix}_DEPLOYMENT_EXPOSURE`, otherExposure);
              vi.stubEnv(`${prefix}_BIND`, otherBind);
              vi.stubEnv(`${prefix}_BIND_HOST`, "198.51.100.9");
              vi.stubEnv(`${prefix}_AGENT_JWT_SECRET`, "");
            }
            const log = vi.spyOn(console, "log").mockImplementation(() => {});

            printStartupBanner(opts);

            expect(log).toHaveBeenCalledTimes(1);
            expect(log.mock.calls[0]).toHaveLength(1);
            const output = String(log.mock.calls[0][0]).replace(/\x1b\[[0-9;]*m/g, "");
            const rows = output.split("\n");
            const value = (label: string) => {
              const matches = rows.filter((line) => line.startsWith(`${label} `));
              expect(matches).toHaveLength(1);
              return matches[0].slice(label.length).trim();
            };
            expect(value("Deploy")).toBe(`${deploymentMode} (${deploymentExposure})`);
            expect(value("Bind")).toBe(`${bind} (192.0.2.42)`);
            expect(value("Auth")).toBe(authReady ? "ready" : "not-ready");
          });
        }
      }
    }
  }
});
