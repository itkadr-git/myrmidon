import { beforeEach, describe, expect, it, vi } from \"vitest\";
import {
  executeGeoCheck,
  geoCheckCommand,
  type GeoCheckDependencies,
} from \"../commands/geo-check.js\";

describe(\"cli — executeGeoCheck\", () => {
  const passingDeps: GeoCheckDependencies = {
    readOsRelease: () => `
ID=ubuntu
VERSION_ID=\"24.04\"
PRETTY_NAME=\"Ubuntu 24.04 LTS\"
`,
    execCmd: async (file) => {
      if (file === \"docker\") return \"26.1.3\";
      if (file === \"psql\") return \"psql (PostgreSQL) 16.2\";
      return null;
    },
    probePort: async () => true,
    readMirrorConfig: () => \"model_list:\\n  - litellm_params:\\n      mirror: https://primary.internal:4000\",
    env: {
      DATABASE_URL: \"postgres://localhost:5432/myrmidon\",
      LITELLM_MASTER_KEY: \"sk-master-key\",
      LITELLM_API_KEY: \"sk-api-key\",
    },
  };

  it(\"returns passed: true when all 7 checks succeed\", async () => {
    const report = await executeGeoCheck(
      {
        pgHost: \"127.0.0.1\",
        pgPort: 5432,
        litellmHost: \"127.0.0.1\",
        litellmPort: 4000,
        secrets: \"DATABASE_URL,LITELLM_MASTER_KEY,LITELLM_API_KEY\",
        mirrorConfig: \"/etc/litellm.yaml\",
        minOsMajor: 22,
        minDockerMajor: 24,
        minPgMajor: 14,
        timeoutMs: 1000,
        json: false,
      },
      passingDeps,
    );

    expect(report.passed).toBe(true);
    expect(report.totalChecks).toBe(7);
    expect(report.passedChecks).toBe(7);
    expect(report.failedChecks).toBe(0);

    const checkNames = report.checks.map((c) => c.name);
    expect(checkNames).toContain(\"OS version\");
    expect(checkNames).toContain(\"Docker version\");
    expect(checkNames).toContain(\"PostgreSQL client\");
    expect(checkNames).toContain(\"PostgreSQL port\");
    expect(checkNames).toContain(\"LiteLLM port\");
    expect(checkNames).toContain(\"Secret quorum\");
    expect(checkNames).toContain(\"LiteLLM mirror config\");
  });

  it(\"identifies failed checks when components fail\", async () => {
    const failingDeps: GeoCheckDependencies = {
      readOsRelease: () => \"ID=ubuntu\\nVERSION_ID=\\\"20.04\\\"\\n\",
      execCmd: async (file) => {
        if (file === \"docker\") return \"20.10.0\";
        if (file === \"psql\") return null; // psql not installed
        return null;
      },
      probePort: async (_h, port) => port === 5432, // LiteLLM port (4000) unreachable
      readMirrorConfig: () => null, // config not found
      env: {
        DATABASE_URL: \"postgres://localhost:5432/myrmidon\",
        // LITELLM keys missing
      },
    };

    const report = await executeGeoCheck(
      {
        pgHost: \"127.0.0.1\",
        pgPort: 5432,
        litellmHost: \"127.0.0.1\",
        litellmPort: 4000,
        secrets: \"DATABASE_URL,LITELLM_MASTER_KEY,LITELLM_API_KEY\",
        mirrorConfig: \"/etc/litellm.yaml\",
        minOsMajor: 22,
        minDockerMajor: 24,
        minPgMajor: 14,
        timeoutMs: 1000,
        json: false,
      },
      failingDeps,
    );

    expect(report.passed).toBe(false);
    expect(report.failedChecks).toBeGreaterThan(0);

    const failed = report.checks.filter((c) => c.status === \"fail\").map((c) => c.name);
    expect(failed).toContain(\"OS version\");
    expect(failed).toContain(\"Docker version\");
    expect(failed).toContain(\"PostgreSQL client\");
    expect(failed).toContain(\"LiteLLM port\");
    expect(failed).toContain(\"Secret quorum\");
    expect(failed).toContain(\"LiteLLM mirror config\");
  });
});

describe(\"cli — geoCheckCommand\", () => {
  beforeEach(() => {
    process.exitCode = undefined;
  });

  it(\"outputs JSON report when json: true is passed\", async () => {
    const consoleSpy = vi.spyOn(console, \"log\").mockImplementation(() => {});

    const deps: GeoCheckDependencies = {
      readOsRelease: () => \"ID=debian\\nVERSION_ID=\\\"12\\\"\\nPRETTY_NAME=\\\"Debian 12\\\"\",
      execCmd: async () => \"26.0.0\",
      probePort: async () => true,
      readMirrorConfig: () => \"mirror: https://primary:4000\",
      env: {
        DATABASE_URL: \"postgres://...\",
        LITELLM_MASTER_KEY: \"master\",
        LITELLM_API_KEY: \"key\",
      },
    };

    const report = await geoCheckCommand(
      {
        json: true,
        mirrorConfig: \"/etc/config.yaml\",
      },
      deps,
    );

    expect(report.passed).toBe(true);
    expect(consoleSpy).toHaveBeenCalled();
    const loggedOutput = consoleSpy.mock.calls[0]?.[0];
    const parsedJson = JSON.parse(loggedOutput as string);
    expect(parsedJson.passed).toBe(true);
    expect(parsedJson.totalChecks).toBe(7);

    consoleSpy.mockRestore();
  });

  it(\"rejects invalid input options and sets exit code 1\", async () => {
    await expect(
      geoCheckCommand({
        pgPort: 99999, // invalid port
        json: true,
      }),
    ).rejects.toThrow(/Invalid geo-check options/);

    expect(process.exitCode).toBe(1);
  });
});
