import { afterEach, describe, expect, it, vi } from "vitest";
import { printStartupBanner } from "../startup-banner.js";

vi.mock("../paths.js", () => ({
  resolvePaperclipConfigPath: () => "/fixture/config.json",
  resolvePaperclipEnvPath: () => "/fixture/.env",
}));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: () => false,
}));

const cases = [
  { name: "password", url: "postgres://alice:plainSecret@db.example:5432/app", expected: "postgres://alice:***@db.example:5432/app", secrets: ["plainSecret"] },
  { name: "encoded password", url: "postgres://alice:encoded%40Secret@db.example/app", expected: "postgres://alice:***@db.example/app", secrets: ["encoded%40Secret", "encoded@Secret"] },
  { name: "query and fragment", url: "postgres://alice:passSecret@db.example/app?token=querySecret#fragmentSecret", expected: "postgres://alice:***@db.example/app", secrets: ["passSecret", "querySecret", "fragmentSecret", "?token=", "#fragmentSecret"] },
  { name: "IPv6 and port", url: "postgres://bob:ipv6Secret@[2001:db8::1]:6543/db", expected: "postgres://bob:***@[2001:db8::1]:6543/db", secrets: ["ipv6Secret"] },
  { name: "no username", url: "postgres://db.example/app?token=anonymousSecret", expected: "postgres://user:***@db.example/app", secrets: ["anonymousSecret", "?token="] },
  { name: "malformed URL", url: "not-a-url-malformedSecret", expected: "<invalid DATABASE_URL>", secrets: ["not-a-url-malformedSecret", "malformedSecret"] },
];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("startup banner database redaction", () => {
  it("uses unredacted synthetic password fixtures", () => {
    expect(cases[0].url).toContain(cases[0].secrets[0]);
    expect(cases[1].url).toContain(cases[1].secrets[0]);
    expect(decodeURIComponent(cases[1].url)).toContain(cases[1].secrets[1]);
    expect(cases[2].url).toContain(cases[2].secrets[0]);
    expect(cases[3].url).toContain(cases[3].secrets[0]);
  });

  it.each(cases)("redacts $name while retaining useful banner details", ({ url, expected, secrets }) => {
    vi.stubEnv("MYRMIDON_AGENT_JWT_SECRET", "");
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    printStartupBanner({
      bind: "loopback",
      host: "localhost",
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      requestedPort: 3100,
      listenPort: 3100,
      uiMode: "static",
      db: { mode: "external-postgres", connectionString: url },
      migrationSummary: "up to date",
      heartbeatSchedulerEnabled: false,
      heartbeatSchedulerIntervalMs: 1000,
      databaseBackupEnabled: false,
      databaseBackupIntervalMinutes: 60,
      databaseBackupRetentionDays: 7,
      databaseBackupDir: "/fixture/backups",
    });

    expect(log).toHaveBeenCalledTimes(1);
    const output = String(log.mock.calls[0][0]).replace(/\x1b\[[0-9;]*m/g, "");
    expect(output).toContain(`Database         ${expected}`);
    expect(output).toContain("API              http://localhost:3100/api");
    expect(output).toContain("UI               http://localhost:3100");
    expect(output).toContain("external-postgres");
    for (const secret of secrets) expect(output).not.toContain(secret);
  });
});
