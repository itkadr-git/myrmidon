import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  envPath: "/synthetic/instance/.env",
  exists: vi.fn(),
  read: vi.fn(),
}));

vi.mock("../paths.js", () => ({
  resolvePaperclipConfigPath: () => "/synthetic/instance/config.json",
  resolvePaperclipEnvPath: () => fixture.envPath,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) =>
      path === fixture.envPath ? fixture.exists(path) : actual.existsSync(path),
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) =>
      args[0] === fixture.envPath ? fixture.read(...args) : actual.readFileSync(...args),
  };
});

import { printStartupBanner } from "../startup-banner.js";

const options = {
  bind: "loopback",
  host: "127.0.0.1",
  deploymentMode: "local_trusted",
  deploymentExposure: "private",
  authReady: true,
  requestedPort: 3100,
  listenPort: 3100,
  uiMode: "none",
  db: { mode: "external-postgres", connectionString: "postgres://user:password@localhost/test" },
  migrationSummary: "current",
  heartbeatSchedulerEnabled: false,
  heartbeatSchedulerIntervalMs: 1000,
  databaseBackupEnabled: false,
  databaseBackupIntervalMinutes: 60,
  databaseBackupRetentionDays: 7,
  databaseBackupDir: "/synthetic/backups",
} as const;

const canonicalSecret = "aaa";
const legacySecret = "bbb";
const fileSecret = "ccc";
let log: ReturnType<typeof vi.spyOn>;

function expectStatus(status: string) {
  printStartupBanner(options);
  expect(log).toHaveBeenCalledTimes(1);
  const output = String(log.mock.calls[0][0]);
  const plain = output.replace(/\x1b\[[0-9;]*m/g, "");
  expect(plain.split("\n")).toContain(`Agent JWT        ${status}`);
  for (const secret of [canonicalSecret, legacySecret, fileSecret]) {
    expect(output).not.toContain(secret);
  }
  log.mockClear();
}

describe("startup banner agent JWT source", () => {
  beforeEach(() => {
    vi.stubEnv("MYRMIDON_AGENT_JWT_SECRET", undefined);
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", undefined);
    fixture.exists.mockReset().mockReturnValue(false);
    fixture.read.mockReset();
    log = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([
    ["canonical", canonicalSecret, legacySecret],
    ["legacy fallback", undefined, legacySecret],
  ])("reports %s environment secret as set without reading the file", (_name, canonical, legacy) => {
    vi.stubEnv("MYRMIDON_AGENT_JWT_SECRET", canonical);
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", legacy);
    expectStatus("set");
    expect(fixture.exists).not.toHaveBeenCalled();
    expect(fixture.read).not.toHaveBeenCalled();
  });

  it.each(["", "  \t  "])("does not fall back to legacy when canonical is %j", (canonical) => {
    vi.stubEnv("MYRMIDON_AGENT_JWT_SECRET", canonicalSecret);
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", legacySecret);
    expectStatus("set");
    vi.stubEnv("MYRMIDON_AGENT_JWT_SECRET", canonical);
    expectStatus("missing (run `npx myrmidon onboard`)");
    expect(fixture.exists).toHaveBeenCalledWith(fixture.envPath);
    expect(fixture.read).not.toHaveBeenCalled();
  });

  it.each(["MYRMIDON_AGENT_JWT_SECRET", "PAPERCLIP_AGENT_JWT_SECRET"])(
    "reports an unloaded %s from the env file without printing it",
    (key) => {
      fixture.exists.mockReturnValue(true);
      fixture.read.mockReturnValue(`${key}=${fileSecret}\n`);
      expectStatus(`found in ${fixture.envPath} but not loaded`);
      expect(fixture.read).toHaveBeenCalledWith(fixture.envPath, "utf-8");
    },
  );

  it.each(["", "   \n\t  "])("reports an empty or whitespace env file as missing: %j", (contents) => {
    fixture.exists.mockReturnValue(true);
    fixture.read.mockReturnValue(`MYRMIDON_AGENT_JWT_SECRET=${fileSecret}\n`);
    expectStatus(`found in ${fixture.envPath} but not loaded`);
    fixture.read.mockReturnValue(contents);
    expectStatus("missing (run `npx myrmidon onboard`)");
  });

  it("recomputes the source on successive calls", () => {
    vi.stubEnv("MYRMIDON_AGENT_JWT_SECRET", canonicalSecret);
    expectStatus("set");
    vi.stubEnv("MYRMIDON_AGENT_JWT_SECRET", undefined);
    fixture.exists.mockReturnValue(true);
    fixture.read.mockReturnValue(`PAPERCLIP_AGENT_JWT_SECRET=${fileSecret}\n`);
    expectStatus(`found in ${fixture.envPath} but not loaded`);
    fixture.exists.mockReturnValue(false);
    expectStatus("missing (run `npx myrmidon onboard`)");
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", legacySecret);
    expectStatus("set");
  });
});
