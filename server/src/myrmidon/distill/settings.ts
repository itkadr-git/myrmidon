// server/src/myrmidon/distill/settings.ts
//
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-5): the switch, the period, the budgets and
// the auto-accept list for the distiller v2 sweep.
//
// The shape follows the foraging settings pattern (1.6-FORAGING /
// FORAGING-LIMITS-UI): a stored instance-settings row, per-key environment
// overrides, built-in defaults — resolved on every tick so a change from the
// interface applies without a restart. The budgets are signals: a pass that
// crosses them reports the signal in the knowledge journal instead of crashing
// (§4.5: «бесплатная модель; бюджет 1 млн токенов/30 мин — сигнал»).
//
// The model key is named, never carried: `MYRMIDON_DISTILL_KEY_SECRET` holds
// the NAME of a company secret whose value authenticates against the free-model
// gateway (`MYRMIDON_DISTILL_GATEWAY_URL`). No key env, no raw value logged.

import { DEFAULT_DISTILL_BUDGET } from "./domain.js";

export const DISTILL_SETTINGS_KEY = "knowledgeDistill";
export const DISTILL_ENABLED_ENV = "MYRMIDON_DISTILL_ENABLED";
export const DISTILL_INTERVAL_SEC_ENV = "MYRMIDON_DISTILL_INTERVAL_SEC";
export const DISTILL_WINDOW_SEC_ENV = "MYRMIDON_DISTILL_WINDOW_SEC";
export const DISTILL_MAX_INPUT_TOKENS_ENV = "MYRMIDON_DISTILL_MAX_INPUT_TOKENS";
export const DISTILL_MAX_DURATION_SEC_ENV = "MYRMIDON_DISTILL_MAX_DURATION_SEC";
export const DISTILL_MAX_TASKS_ENV = "MYRMIDON_DISTILL_MAX_TASKS";
export const DISTILL_MODEL_ENV = "MYRMIDON_DISTILL_MODEL";
export const DISTILL_GATEWAY_URL_ENV = "MYRMIDON_DISTILL_GATEWAY_URL";
export const DISTILL_KEY_SECRET_ENV = "MYRMIDON_DISTILL_KEY_SECRET";
export const DISTILL_AUTO_ACCEPT_ENV = "MYRMIDON_DISTILL_AUTO_ACCEPT";

/** The daily rhythm default: one pass per 24 h over a 24 h window. */
export const DISTILL_DEFAULT_INTERVAL_SEC = 24 * 60 * 60;
export const DISTILL_DEFAULT_WINDOW_SEC = 24 * 60 * 60;
/** Raw-material cap per pass; keeps the token budget realistic (§4.5). */
export const DISTILL_DEFAULT_MAX_TASKS = 150;

export interface DistillSettings {
  enabled: boolean;
  intervalSec: number;
  windowSec: number;
  maxInputTokens: number;
  maxDurationSec: number;
  maxTasksPerPass: number;
  /** Free model at the gateway (decision: бесплатная модель). */
  model: string;
  /** Sections that may auto-accept: subset of glossary|releases|how-made. */
  autoAcceptSections: string[];
}

export interface ResolvedDistillSettings {
  settings: DistillSettings;
  /** Name of the company secret carrying the gateway key, or null (env only). */
  keySecret: string | null;
  gatewayUrl: string | null;
  intervalMs: number;
  windowMs: number;
}

const BUILTIN: DistillSettings = {
  enabled: false,
  intervalSec: DISTILL_DEFAULT_INTERVAL_SEC,
  windowSec: DISTILL_DEFAULT_WINDOW_SEC,
  maxInputTokens: DEFAULT_DISTILL_BUDGET.maxInputTokens,
  maxDurationSec: DEFAULT_DISTILL_BUDGET.maxDurationMs / 1000,
  maxTasksPerPass: DISTILL_DEFAULT_MAX_TASKS,
  model: "free",
  autoAcceptSections: [],
};

function num(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value === "1" || value === "true";
  return fallback;
}

function sections(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value)) return value.filter((s): s is string => typeof s === "string");
  if (typeof value === "string" && value.trim()) {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return fallback;
}

/**
 * Pure precedence: stored row → per-key env override → built-in default.
 * Exported for the settings test; `resolveDistillSettings` composes it with
 * the key-name/gateway env, which are env-only (never stored).
 */
export function mergeDistillSettings(stored: unknown, env: NodeJS.ProcessEnv): DistillSettings {
  const row = (stored && typeof stored === "object" ? stored : {}) as Record<string, unknown>;
  return {
    enabled: bool(env[DISTILL_ENABLED_ENV], bool(row.enabled, BUILTIN.enabled)),
    intervalSec: num(env[DISTILL_INTERVAL_SEC_ENV], num(row.intervalSec, BUILTIN.intervalSec)),
    windowSec: num(env[DISTILL_WINDOW_SEC_ENV], num(row.windowSec, BUILTIN.windowSec)),
    maxInputTokens: num(env[DISTILL_MAX_INPUT_TOKENS_ENV], num(row.maxInputTokens, BUILTIN.maxInputTokens)),
    maxDurationSec: num(env[DISTILL_MAX_DURATION_SEC_ENV], num(row.maxDurationSec, BUILTIN.maxDurationSec)),
    maxTasksPerPass: num(env[DISTILL_MAX_TASKS_ENV], num(row.maxTasksPerPass, BUILTIN.maxTasksPerPass)),
    model: (env[DISTILL_MODEL_ENV] || row.model || BUILTIN.model) as string,
    autoAcceptSections: sections(
      env[DISTILL_AUTO_ACCEPT_ENV] ?? row.autoAcceptSections,
      BUILTIN.autoAcceptSections,
    ),
  };
}

export function resolveDistillSettings(
  stored: Record<string, unknown> | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedDistillSettings {
  const settings = mergeDistillSettings(stored?.[DISTILL_SETTINGS_KEY], env);
  return {
    settings,
    keySecret: env[DISTILL_KEY_SECRET_ENV]?.trim() || null,
    gatewayUrl: env[DISTILL_GATEWAY_URL_ENV]?.trim() || null,
    intervalMs: settings.intervalSec * 1000,
    windowMs: settings.windowSec * 1000,
  };
}

/** Activity action written for every distiller settings change. */
export const DISTILL_SETTINGS_UPDATED_ACTION = "instance.knowledge-distill.updated";
