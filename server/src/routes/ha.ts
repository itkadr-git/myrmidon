import { Router } from "express";
import type { HaStandbyStatus } from "@myrmidon/shared";
import {
  haStandbyStatusSchema,
  haStandbyCheckSchema,
  haStandbyCheckStatusSchema,
} from "@myrmidon/shared";
import { readProductEnv, type ProductEnv } from "@myrmidon/shared/env-alias";

const STANDBY_URL_ENV_KEY = "HA_GEO_STANDBY_URL";
const PROBE_TIMEOUT_MS = 5_000;

/** Probe paths against the standby site, named for the status report. */
const STANDBY_PROBES: ReadonlyArray<{ name: string; path: string }> = [
  { name: "health", path: "/api/health" },
] as const;

export function resolveStandbyBaseUrl(env: ProductEnv = process.env): string | undefined {
  const value = readProductEnv(STANDBY_URL_ENV_KEY, { env })?.trim();
  return value ? value.replace(/\/+$/, "") : undefined;
}

function statusFromChecks(checks: HaStandbyStatus["checks"]): HaStandbyStatus["status"] {
  if (checks.length === 0) return "not_configured";
  return checks.every((check) => check.status === "ready") ? "ready" : "unhealthy";
}

export interface StandbyStatusOptions {
  env?: ProductEnv;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/**
 * Read-only standby site status built from readiness probes.
 *
 * - No standby URL configured → explicit `not_configured`; a second site is not required.
 * - Each probe reports its own status and timestamp; one probe failing never throws away
 *   the whole response — the failure is recorded and the other checks still report.
 * - The result contains only names, statuses, and timestamps. Probe errors and the base
 *   URL (which may embed credentials) are never copied into the JSON.
 */
export async function getStandbyStatus(options: StandbyStatusOptions = {}): Promise<HaStandbyStatus> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const checkedAt = now().toISOString();

  const baseUrl = resolveStandbyBaseUrl(options.env);
  if (!baseUrl) {
    return { status: "not_configured", checkedAt, checks: [] };
  }

  const check = async (name: string, path: string) => {
    const checkAt = now().toISOString();
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        headers: { accept: "application/json" },
      });
      return haStandbyCheckSchema.parse({ name, status: response.ok ? "ready" : "unhealthy", checkedAt: checkAt });
    } catch {
      // Probe-level failure (network, timeout, non-2xx): recorded per check, never thrown.
      return haStandbyCheckSchema.parse({ name, status: "unhealthy", checkedAt: checkAt });
    }
  };

  // Independent probes: Promise.all is safe because `check` never rejects.
  const checks = await Promise.all(STANDBY_PROBES.map((probe) => check(probe.name, probe.path)));
  return haStandbyStatusSchema.parse({ status: statusFromChecks(checks), checkedAt, checks });
}

export function haRoutes() {
  const router = Router();
  router.get("/standby", async (_req, res) => {
    const result = await getStandbyStatus();
    // 503 only reflects probe results. `not_configured` is a valid answer, not an outage.
    res.status(result.status === "unhealthy" ? 503 : 200).json(result);
  });
  return router;
}

export { haStandbyStatusSchema, haStandbyCheckSchema, haStandbyCheckStatusSchema };
