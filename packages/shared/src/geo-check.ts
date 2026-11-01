import {
  type GeoCheckItem,
  type GeoCheckReport,
} from "./validators/geo-check.js";

export function extractMajorVersion(versionStr: string): number | null {
  const match = versionStr.match(/[0-9]+/);
  if (!match) return null;
  const num = parseInt(match[0], 10);
  return Number.isSafeInteger(num) ? num : null;
}

export function parseOsRelease(content: string): {
  id: string;
  versionId: string;
  prettyName: string;
} {
  let id = "unknown";
  let versionId = "";
  let prettyName = "";

  for (const line of content.split("\\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key === "ID") id = val.toLowerCase();
    else if (key === "VERSION_ID") versionId = val;
    else if (key === "PRETTY_NAME") prettyName = val;
  }

  return { id, versionId, prettyName };
}

export function evaluateOsReadiness(
  osInfo: { id: string; versionId: string; prettyName?: string } | null,
  minMajorFallback = 22,
  debianMinMajor = 12,
  ubuntuMinMajor = 22,
): GeoCheckItem {
  const name = "OS version";
  if (!osInfo) {
    return {
      name,
      status: "fail",
      detail: `Unable to read OS information (minimum major ${minMajorFallback})`,
    };
  }

  const { id, versionId, prettyName } = osInfo;
  let osMinimum = minMajorFallback;
  if (id === "debian") osMinimum = debianMinMajor;
  else if (id === "ubuntu") osMinimum = ubuntuMinMajor;

  const major = extractMajorVersion(versionId);
  if (major !== null && major >= osMinimum) {
    return {
      name,
      status: "pass",
      detail: `${prettyName || id} (minimum major ${osMinimum} for ${id})`,
    };
  }

  return {
    name,
    status: "fail",
    detail: `${versionId || "unknown"} for ${id} (minimum major ${osMinimum})`,
  };
}

export function evaluateDockerReadiness(
  dockerVersion: string | null,
  minDockerMajor = 24,
): GeoCheckItem {
  const name = "Docker version";
  if (!dockerVersion) {
    return {
      name,
      status: "fail",
      detail: `docker unavailable (minimum major ${minDockerMajor})`,
    };
  }

  const major = extractMajorVersion(dockerVersion);
  if (major !== null && major >= minDockerMajor) {
    return {
      name,
      status: "pass",
      detail: `${dockerVersion.trim()} (minimum major ${minDockerMajor})`,
    };
  }

  return {
    name,
    status: "fail",
    detail: `${dockerVersion.trim() || "docker unavailable"} (minimum major ${minDockerMajor})`,
  };
}

export function evaluatePgClientReadiness(
  psqlVersion: string | null,
  minPgMajor = 14,
): GeoCheckItem {
  const name = "PostgreSQL client";
  if (!psqlVersion) {
    return {
      name,
      status: "fail",
      detail: `psql unavailable (minimum major ${minPgMajor})`,
    };
  }

  const major = extractMajorVersion(psqlVersion);
  if (major !== null && major >= minPgMajor) {
    return {
      name,
      status: "pass",
      detail: `${psqlVersion.trim()} (minimum major ${minPgMajor})`,
    };
  }

  return {
    name,
    status: "fail",
    detail: `${psqlVersion.trim() || "psql unavailable"} (minimum major ${minPgMajor})`,
  };
}

export function evaluatePortReadiness(
  serviceName: string,
  host: string,
  port: number,
  reachable: boolean,
): GeoCheckItem {
  return {
    name: `${serviceName} port`,
    status: reachable ? "pass" : "fail",
    detail: reachable ? `${host}:${port} is reachable` : `${host}:${port} is not reachable`,
  };
}

export function evaluateSecretsReadiness(
  secretNames: string[],
  env: Record<string, string | undefined>,
): GeoCheckItem {
  const name = "Secret quorum";
  const missing: string[] = [];

  for (const secret of secretNames) {
    const val = env[secret];
    if (val === undefined || val === null || val.trim() === "") {
      missing.push(secret);
    }
  }

  if (missing.length === 0) {
    return {
      name,
      status: "pass",
      detail: `${secretNames.length} required secrets are set`,
    };
  }

  return {
    name,
    status: "fail",
    detail: `missing: ${missing.join(", ")}`,
  };
}

export const MIRROR_CONFIG_REGEX = /(?:^|\s)(?:mirror|api_base|base_url)\s*[:=]/i;

export function evaluateMirrorConfigReadiness(
  filePath: string | undefined,
  content: string | null,
): GeoCheckItem {
  const name = "LiteLLM mirror config";
  if (!filePath || content === null) {
    return {
      name,
      status: "fail",
      detail: "set LITELLM_MIRROR_CONFIG to a readable config file",
    };
  }

  if (MIRROR_CONFIG_REGEX.test(content)) {
    return {
      name,
      status: "pass",
      detail: `${filePath} contains a mirror endpoint`,
    };
  }

  return {
    name,
    status: "fail",
    detail: `${filePath} has no mirror endpoint`,
  };
}

export function buildGeoCheckReport(checks: GeoCheckItem[]): GeoCheckReport {
  const passedChecks = checks.filter((c) => c.status === "pass").length;
  const failedChecks = checks.filter((c) => c.status === "fail").length;
  return {
    passed: failedChecks === 0,
    totalChecks: checks.length,
    passedChecks,
    failedChecks,
    checks,
  };
}
