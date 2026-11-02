import { describe, expect, it } from "vitest";
import {
  buildGeoCheckReport,
  evaluateDockerReadiness,
  evaluateMirrorConfigReadiness,
  evaluateOsReadiness,
  evaluatePgClientReadiness,
  evaluatePortReadiness,
  evaluateSecretsReadiness,
  extractMajorVersion,
  parseOsRelease,
} from "./geo-check.js";
import { geoCheckOptionsSchema } from "./validators/geo-check.js";

describe("geo-check — extractMajorVersion", () => {
  it("extracts first numeric integer sequence", () => {
    expect(extractMajorVersion("24.0.5")).toBe(24);
    expect(extractMajorVersion("psql (PostgreSQL) 16.2 (Ubuntu)")).toBe(16);
    expect(extractMajorVersion("v22.4.1")).toBe(22);
    expect(extractMajorVersion("Docker version 26.1.3, build b722938")).toBe(26);
    expect(extractMajorVersion("no-numbers-here")).toBeNull();
    expect(extractMajorVersion("")).toBeNull();
  });
});

describe("geo-check — parseOsRelease", () => {
  it("parses standard /etc/os-release fields with and without quotes", () => {
    const raw = `
NAME="Ubuntu"
VERSION="24.04 LTS (Noble Numbat)"
ID=ubuntu
ID_LIKE=debian
PRETTY_NAME="Ubuntu 24.04 LTS"
VERSION_ID="24.04"
HOME_URL="https://www.ubuntu.com/"
`;
    const parsed = parseOsRelease(raw);
    expect(parsed.id).toBe("ubuntu");
    expect(parsed.versionId).toBe("24.04");
    expect(parsed.prettyName).toBe("Ubuntu 24.04 LTS");
  });

  it("handles debian os-release", () => {
    const raw = `
PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"
NAME="Debian GNU/Linux"
VERSION_ID="12"
VERSION="12 (bookworm)"
ID=debian
`;
    const parsed = parseOsRelease(raw);
    expect(parsed.id).toBe("debian");
    expect(parsed.versionId).toBe("12");
    expect(parsed.prettyName).toBe("Debian GNU/Linux 12 (bookworm)");
  });

  it("gracefully defaults on empty content", () => {
    const parsed = parseOsRelease("");
    expect(parsed.id).toBe("unknown");
    expect(parsed.versionId).toBe("");
    expect(parsed.prettyName).toBe("");
  });
});

describe("geo-check — evaluateOsReadiness", () => {
  it("passes when debian is >= 12", () => {
    const res = evaluateOsReadiness({ id: "debian", versionId: "12", prettyName: "Debian 12" });
    expect(res.status).toBe("pass");
    expect(res.detail).toContain("minimum major 12 for debian");
  });

  it("fails when debian is < 12", () => {
    const res = evaluateOsReadiness({ id: "debian", versionId: "11", prettyName: "Debian 11" });
    expect(res.status).toBe("fail");
    expect(res.detail).toContain("minimum major 12");
  });

  it("passes when ubuntu is >= 22", () => {
    const res = evaluateOsReadiness({ id: "ubuntu", versionId: "24.04", prettyName: "Ubuntu 24.04" });
    expect(res.status).toBe("pass");
    expect(res.detail).toContain("minimum major 22 for ubuntu");
  });

  it("fails when ubuntu is < 22", () => {
    const res = evaluateOsReadiness({ id: "ubuntu", versionId: "20.04", prettyName: "Ubuntu 20.04" });
    expect(res.status).toBe("fail");
    expect(res.detail).toContain("minimum major 22");
  });

  it("handles generic Linux with fallback minOsMajor", () => {
    const passRes = evaluateOsReadiness({ id: "almalinux", versionId: "22", prettyName: "AlmaLinux 22" }, 22);
    expect(passRes.status).toBe("pass");

    const failRes = evaluateOsReadiness({ id: "almalinux", versionId: "9", prettyName: "AlmaLinux 9" }, 22);
    expect(failRes.status).toBe("fail");
  });

  it("fails when osInfo is null", () => {
    const res = evaluateOsReadiness(null, 22);
    expect(res.status).toBe("fail");
    expect(res.detail).toContain("Unable to read OS information");
  });
});

describe("geo-check — evaluateDockerReadiness", () => {
  it("passes when docker version is >= 24", () => {
    const res = evaluateDockerReadiness("26.1.3", 24);
    expect(res.status).toBe("pass");
    expect(res.detail).toContain("26.1.3 (minimum major 24)");
  });

  it("fails when docker version is < 24", () => {
    const res = evaluateDockerReadiness("20.10.21", 24);
    expect(res.status).toBe("fail");
    expect(res.detail).toContain("minimum major 24");
  });

  it("fails when docker is unavailable / null", () => {
    const res = evaluateDockerReadiness(null, 24);
    expect(res.status).toBe("fail");
    expect(res.detail).toContain("docker unavailable");
  });
});

describe("geo-check — evaluatePgClientReadiness", () => {
  it("passes when psql version is >= 14", () => {
    const res = evaluatePgClientReadiness("psql (PostgreSQL) 16.2", 14);
    expect(res.status).toBe("pass");
    expect(res.detail).toContain("minimum major 14");
  });

  it("fails when psql version is < 14", () => {
    const res = evaluatePgClientReadiness("psql (PostgreSQL) 13.8", 14);
    expect(res.status).toBe("fail");
    expect(res.detail).toContain("minimum major 14");
  });

  it("fails when psql is unavailable / null", () => {
    const res = evaluatePgClientReadiness(null, 14);
    expect(res.status).toBe("fail");
    expect(res.detail).toContain("psql unavailable");
  });
});

describe("geo-check — evaluatePortReadiness", () => {
  it("reports pass when reachable", () => {
    const res = evaluatePortReadiness("PostgreSQL", "127.0.0.1", 5432, true);
    expect(res.name).toBe("PostgreSQL port");
    expect(res.status).toBe("pass");
    expect(res.detail).toBe("127.0.0.1:5432 is reachable");
  });

  it("reports fail when unreachable", () => {
    const res = evaluatePortReadiness("LiteLLM", "127.0.0.1", 4000, false);
    expect(res.name).toBe("LiteLLM port");
    expect(res.status).toBe("fail");
    expect(res.detail).toBe("127.0.0.1:4000 is not reachable");
  });
});

describe("geo-check — evaluateSecretsReadiness", () => {
  it("passes when all required secrets are set and non-empty", () => {
    const env = {
      DATABASE_URL: "postgres://user:pass@localhost:5432/db",
      LITELLM_MASTER_KEY: "sk-master-123",
      LITELLM_API_KEY: "sk-agent-456",
    };
    const res = evaluateSecretsReadiness(["DATABASE_URL", "LITELLM_MASTER_KEY", "LITELLM_API_KEY"], env);
    expect(res.status).toBe("pass");
    expect(res.detail).toBe("3 required secrets are set");
  });

  it("fails when one or more required secrets are missing or blank", () => {
    const env = {
      DATABASE_URL: "postgres://localhost:5432/db",
      LITELLM_MASTER_KEY: "   ", // empty whitespace
    };
    const res = evaluateSecretsReadiness(["DATABASE_URL", "LITELLM_MASTER_KEY", "LITELLM_API_KEY"], env);
    expect(res.status).toBe("fail");
    expect(res.detail).toBe("missing: LITELLM_MASTER_KEY, LITELLM_API_KEY");
  });
});

describe("geo-check — evaluateMirrorConfigReadiness", () => {
  it("passes when config contains mirror directive", () => {
    const yaml = `
model_list:
  - model_name: gpt-4
    litellm_params:
      mirror: https://primary.internal:4000
`;
    const res = evaluateMirrorConfigReadiness("/etc/litellm.yaml", yaml);
    expect(res.status).toBe("pass");
    expect(res.detail).toBe("/etc/litellm.yaml contains a mirror endpoint");
  });

  it("passes when config contains api_base or base_url", () => {
    const yaml = `
model_list:
  - model_name: gpt-4
    litellm_params:
      api_base: https://primary.internal:4000
`;
    const res = evaluateMirrorConfigReadiness("/etc/litellm.yaml", yaml);
    expect(res.status).toBe("pass");
  });

  it("fails when config does not contain a mirror endpoint", () => {
    const yaml = `
model_list:
  - model_name: gpt-4
    litellm_params:
      model: openai/gpt-4
`;
    const res = evaluateMirrorConfigReadiness("/etc/litellm.yaml", yaml);
    expect(res.status).toBe("fail");
    expect(res.detail).toBe("/etc/litellm.yaml has no mirror endpoint");
  });

  it("fails when path is undefined or content is null", () => {
    const res = evaluateMirrorConfigReadiness(undefined, null);
    expect(res.status).toBe("fail");
    expect(res.detail).toBe("set LITELLM_MIRROR_CONFIG to a readable config file");
  });
});

describe("geo-check — buildGeoCheckReport", () => {
  it("aggregates passed and failed counts correctly", () => {
    const report = buildGeoCheckReport([
      { name: "OS version", status: "pass", detail: "ok" },
      { name: "Docker version", status: "pass", detail: "ok" },
      { name: "PostgreSQL port", status: "fail", detail: "unreachable" },
    ]);
    expect(report.passed).toBe(false);
    expect(report.totalChecks).toBe(3);
    expect(report.passedChecks).toBe(2);
    expect(report.failedChecks).toBe(1);
  });
});

describe("geo-check — options schema validation", () => {
  it("applies correct defaults", () => {
    const parsed = geoCheckOptionsSchema.parse({});
    expect(parsed.pgHost).toBe("127.0.0.1");
    expect(parsed.pgPort).toBe(5432);
    expect(parsed.litellmHost).toBe("127.0.0.1");
    expect(parsed.litellmPort).toBe(4000);
    expect(parsed.minOsMajor).toBe(22);
    expect(parsed.minDockerMajor).toBe(24);
    expect(parsed.minPgMajor).toBe(14);
    expect(parsed.timeoutMs).toBe(2000);
    expect(parsed.json).toBe(false);
  });

  it("coerces strings to numbers where appropriate", () => {
    const parsed = geoCheckOptionsSchema.parse({
      pgPort: "5433",
      litellmPort: "4001",
      minOsMajor: "12",
      minDockerMajor: "25",
      minPgMajor: "16",
      timeoutMs: "3000",
    });
    expect(parsed.pgPort).toBe(5433);
    expect(parsed.litellmPort).toBe(4001);
    expect(parsed.minOsMajor).toBe(12);
    expect(parsed.minDockerMajor).toBe(25);
    expect(parsed.minPgMajor).toBe(16);
    expect(parsed.timeoutMs).toBe(3000);
  });

  it("rejects invalid port numbers", () => {
    const invalidPortRes = geoCheckOptionsSchema.safeParse({ pgPort: 70000 });
    expect(invalidPortRes.success).toBe(false);

    const negativePortRes = geoCheckOptionsSchema.safeParse({ litellmPort: -1 });
    expect(negativePortRes.success).toBe(false);
  });
});
