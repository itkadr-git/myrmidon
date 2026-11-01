import { Router } from "express";
import { readProductEnv } from "@myrmidon/shared/env-alias";

export type StandbyCheckStatus = "ready" | "unhealthy" | "not_configured";

export type StandbyCheck = {
  name: string;
  status: StandbyCheckStatus;
  checkedAt: string;
};

export type StandbyStatus = {
  status: StandbyCheckStatus;
  checkedAt: string;
  checks: StandbyCheck[];
};

const standbyUrlEnvKeys = ["HA_GEO_STANDBY_URL", "STANDBY_URL"] as const;

function standbyUrl(): string | undefined {
  for (const key of standbyUrlEnvKeys) {
    const value = readProductEnv(key)?.trim();
    if (value) return value.replace(/\/$/, "");
  }
  return undefined;
}

function statusFromChecks(checks: StandbyCheck[]): StandbyCheckStatus {
  if (checks.length === 0) return "not_configured";
  return checks.every((check) => check.status === "ready") ? "ready" : "unhealthy";
}

export async function getStandbyStatus(fetchImpl: typeof fetch = fetch): Promise<StandbyStatus> {
  const checkedAt = new Date().toISOString();
  const baseUrl = standbyUrl();
  if (!baseUrl) {
    return { status: "not_configured", checkedAt, checks: [] };
  }

  const checks: StandbyCheck[] = [];
  const check = async (name: string, path: string) => {
    const checkTime = new Date().toISOString();
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method: "GET",
        signal: AbortSignal.timeout(5_000),
        headers: { accept: "application/json" },
      });
      checks.push({ name, status: response.ok ? "ready" : "unhealthy", checkedAt: checkTime });
    } catch {
      checks.push({ name, status: "unhealthy", checkedAt: checkTime });
    }
  };

  // Keep checks independent: a failed probe must not hide the result of the others.
  await Promise.all([
    check("health", "/api/health"),
    check("readiness", "/api/health?readiness=true"),
  ]);
  return { status: statusFromChecks(checks), checkedAt, checks };
}

export function haRoutes() {
  const router = Router();
  router.get("/standby", async (_req, res) => {
    const result = await getStandbyStatus();
    res.status(result.status === "unhealthy" ? 503 : 200).json(result);
  });
  return router;
}
