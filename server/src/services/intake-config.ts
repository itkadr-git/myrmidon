// server/src/services/intake-config.ts
// myrmidon(1.7 WEBHOOK-INTAKE): Source and intake configuration parsed from environment variables.
// Rule: Config variables only, no secrets hardcoded in the codebase.

import { readFileSync } from "node:fs";

export interface IntakeSourceConfig {
  enabled?: boolean;
  rateLimit?: {
    maxRequests?: number;
    windowMs?: number;
  };
  tokenRef?: string | null;
  signatureHeader?: string;
  metadata?: Record<string, unknown>;
}

export interface IntakeConfig {
  enabled: boolean;
  sources: Record<string, IntakeSourceConfig>;
  defaultRateLimit: {
    maxRequests: number;
    windowMs: number;
  };
}

export const DEFAULT_INTAKE_RATE_LIMIT_MAX_REQUESTS = 60;
export const DEFAULT_INTAKE_RATE_LIMIT_WINDOW_MS = 60_000;

export const INTAKE_CONFIG_ENV = "MYRMIDON_INTAKE_CONFIG";
export const INTAKE_SOURCES_ENV = "MYRMIDON_INTAKE_SOURCES";
export const INTAKE_ENABLED_ENV = "MYRMIDON_INTAKE_ENABLED";

export function readIntakeConfig(env: NodeJS.ProcessEnv = process.env): IntakeConfig {
  const enabled = env[INTAKE_ENABLED_ENV] !== "false" && env[INTAKE_ENABLED_ENV] !== "0";

  let parsedConfig: Partial<IntakeConfig> = {};
  const rawConfig = env[INTAKE_CONFIG_ENV]?.trim();
  if (rawConfig) {
    try {
      parsedConfig = JSON.parse(rawConfig);
    } catch {
      // Ignore JSON parse errors on invalid env config
    }
  }

  const sources: Record<string, IntakeSourceConfig> = {
    ...(parsedConfig.sources ?? {}),
  };

  const rawSources = env[INTAKE_SOURCES_ENV]?.trim();
  if (rawSources) {
    if (rawSources.startsWith("{")) {
      try {
        const jsonSources = JSON.parse(rawSources);
        Object.assign(sources, jsonSources);
      } catch {
        // Fallback
      }
    } else {
      for (const name of rawSources.split(",")) {
        const trimmed = name.trim();
        if (trimmed && !sources[trimmed]) {
          sources[trimmed] = { enabled: true };
        }
      }
    }
  }

  // Scan for per-source env variables like MYRMIDON_INTAKE_ZABBIX_TOKEN_REF
  const prefix = "MYRMIDON_INTAKE_";
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith(prefix) || !v) continue;
    const rest = k.slice(prefix.length);
    if (["ENABLED", "CONFIG", "SOURCES", "DEFAULT_RATE_LIMIT_MAX", "DEFAULT_RATE_LIMIT_WINDOW_MS"].includes(rest)) {
      continue;
    }
    const parts = rest.split("_");
    if (parts.length >= 2) {
      const prop = parts.slice(1).join("_");
      const src = parts[0].toLowerCase();
      if (!sources[src]) sources[src] = {};
      if (prop === "TOKEN_REF") sources[src].tokenRef = v.trim();
      else if (prop === "ENABLED") sources[src].enabled = v.trim() !== "false" && v.trim() !== "0";
      else if (prop === "SIGNATURE_HEADER") sources[src].signatureHeader = v.trim();
      else if (prop === "MAX_REQUESTS") {
        const num = Number.parseInt(v.trim(), 10);
        if (!Number.isNaN(num)) {
          sources[src].rateLimit = { ...(sources[src].rateLimit ?? {}), maxRequests: num };
        }
      } else if (prop === "WINDOW_MS") {
        const num = Number.parseInt(v.trim(), 10);
        if (!Number.isNaN(num)) {
          sources[src].rateLimit = { ...(sources[src].rateLimit ?? {}), windowMs: num };
        }
      }
    }
  }

  const defaultMaxRequests =
    Number.parseInt(env.MYRMIDON_INTAKE_DEFAULT_RATE_LIMIT_MAX ?? "", 10) ||
    parsedConfig.defaultRateLimit?.maxRequests ||
    DEFAULT_INTAKE_RATE_LIMIT_MAX_REQUESTS;

  const defaultWindowMs =
    Number.parseInt(env.MYRMIDON_INTAKE_DEFAULT_RATE_LIMIT_WINDOW_MS ?? "", 10) ||
    parsedConfig.defaultRateLimit?.windowMs ||
    DEFAULT_INTAKE_RATE_LIMIT_WINDOW_MS;

  return {
    enabled,
    sources,
    defaultRateLimit: {
      maxRequests: defaultMaxRequests,
      windowMs: defaultWindowMs,
    },
  };
}

export function resolveIntakeTokenRef(
  ref: string | null | undefined,
  deps: { env?: NodeJS.ProcessEnv; readFile?: (path: string) => string } = {},
): string | null {
  if (!ref) return null;
  const env = deps.env ?? process.env;
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  let value: string | undefined;
  if (ref.startsWith("env:")) value = env[ref.slice(4)];
  else if (ref.startsWith("file:")) value = readFile(ref.slice(5));
  else return ref;
  return value?.trim() || null;
}
