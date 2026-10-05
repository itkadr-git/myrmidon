import { z } from "zod";

/**
 * Generic behavior settings registry (myrmidon 1.7, SETTINGS-TO-UI A).
 *
 * This module provides a unified server-side mechanism for behavior settings:
 * values from the UI (instance/company settings) → env as forced override → default,
 * applied without restart. This forms the foundation for all other parts of the
 * SETTINGS-TO-UI epic.
 *
 * The precedence, per value, is decided here once and read from both the server
 * and the settings page:
 *
 * - the stored settings value, when the key is present in the appropriate location;
 * - otherwise the environment variable, which stays the default for the first
 *   start on an instance that has never saved these settings;
 * - otherwise the built-in default.
 *
 * Settings can be scoped to instance or company level. Instance-level settings 
 * are stored in `instance_settings.general` (like runLimits), while company-level
 * settings use company settings as already implemented by existing company-scoped
 * settings.
 */

/** Where an effective value came from: UI settings, the environment, or the default. */
export type SettingSource = "ui" | "env" | "default";

/** Scope of the setting: whether it applies to the entire instance or to a specific company. */
export type SettingScope = "instance" | "company";

/** Value type for the setting */
export type SettingValueType = "boolean" | "string" | "number" | "json";

/** Validation function type */
export type SettingValidator<T> = (value: unknown) => T | null;

/** Definition of a behavior setting */
export interface BehaviorSettingDef<T = unknown> {
  /** Unique key for the setting */
  key: string;
  /** Environment variable name for the setting */
  envName: string;
  /** Default value when neither UI nor environment is set */
  default: T;
  /** Scope of the setting: instance-wide or company-specific */
  scope: SettingScope;
  /** Section/group this setting belongs to (for UI organization) */
  section: string;
  /** Type of the setting value */
  valueType: SettingValueType;
  /** Validation function for the value */
  validate: SettingValidator<T>;
}

/** Registry of all behavior settings */
export class BehaviorSettingRegistry {
  private settings: Map<string, BehaviorSettingDef> = new Map();

  register<T>(definition: BehaviorSettingDef<T>): void {
    if (this.settings.has(definition.key)) {
      throw new Error(`Setting with key '${definition.key}' is already registered`);
    }
    this.settings.set(definition.key, definition);
  }

  get(key: string): BehaviorSettingDef | undefined {
    return this.settings.get(key);
  }

  getAll(): BehaviorSettingDef[] {
    return Array.from(this.settings.values());
  }

  getKeys(): string[] {
    return Array.from(this.settings.keys());
  }
}

/** Global registry instance */
export const behaviorSettingRegistry = new BehaviorSettingRegistry();

// Example settings for self-validation - these will be removed in production
behaviorSettingRegistry.register({
  key: "debug_mode",
  envName: "MYRMIDON_DEBUG_MODE",
  default: false,
  scope: "instance",
  section: "development",
  valueType: "boolean",
  validate: (value: unknown): boolean | null => {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const lower = value.toLowerCase();
      if (["true", "1", "yes", "on"].includes(lower)) return true;
      if (["false", "0", "no", "off"].includes(lower)) return false;
    }
    return null;
  },
});

behaviorSettingRegistry.register({
  key: "max_concurrent_agents",
  envName: "MYRMIDON_MAX_CONCURRENT_AGENTS",
  default: 5,
  scope: "instance",
  section: "performance",
  valueType: "number",
  validate: (value: unknown): number | null => {
    const num = typeof value === "number" ? value : Number(value);
    if (Number.isInteger(num) && num > 0) return num;
    return null;
  },
});

behaviorSettingRegistry.register({
  key: "default_timeout_seconds",
  envName: "MYRMIDON_DEFAULT_TIMEOUT_SECONDS",
  default: 300,
  scope: "instance",
  section: "runtime",
  valueType: "number",
  validate: (value: unknown): number | null => {
    const num = typeof value === "number" ? value : Number(value);
    if (Number.isInteger(num) && num > 0) return num;
    return null;
  },
});

/**
 * Parse an environment value based on the setting definition.
 * Returns null when the environment does not declare the setting: either the
 * variable is unset/empty, or its value fails validation. This mirrors
 * `envDeclares` in myrmidon-runtime-limits.ts, where the source is decided by
 * the fact that the environment is set — never by comparing the parsed value
 * against the default (OPE-4094 review, blocker 1).
 */
export function parseSettingFromEnv<T>(raw: string | undefined, def: BehaviorSettingDef<T>): T | null {
  if (raw === undefined || raw === "") return null;
  return def.validate(raw);
}

/**
 * Get the value from environment for a setting, or null when the environment
 * does not declare it.
 */
export function readSettingFromEnv<T>(env: Record<string, string | undefined>, def: BehaviorSettingDef<T>): T | null {
  return parseSettingFromEnv(env[def.envName], def);
}

/**
 * Normalize a raw setting value using its validator
 */
export function normalizeSetting<T>(raw: unknown, def: BehaviorSettingDef<T>): T | null {
  const parsed = def.validate(raw);
  return parsed !== null ? parsed : null;
}

/**
 * Resolve the effective value and source for a setting
 */
export function resolveSetting<T>(options: {
  key: string;
  stored?: unknown;
  env: Record<string, string | undefined>;
}): { value: T; source: SettingSource } {
  const def = behaviorSettingRegistry.get(options.key) as BehaviorSettingDef<T> | undefined;
  if (!def) {
    throw new Error(`Unknown setting key: ${options.key}`);
  }

  const env = options.env;
  
  // Try stored value first
  if (options.stored !== undefined) {
    const normalized = normalizeSetting<T>(options.stored, def);
    if (normalized !== null) {
      return { value: normalized, source: "ui" };
    }
  }
  
  // Then try environment: the source is "env" whenever the environment
  // declares a valid value, even when that value equals the default
  // (mirrors resolveRunLimits' envDeclares semantics).
  const envValue = readSettingFromEnv(env, def);
  if (envValue !== null) {
    return { value: envValue, source: "env" };
  }
  
  // Finally return default
  return { value: def.default, source: "default" };
}

/**
 * Interface for resolved behavior settings
 */
export interface ResolvedBehaviorSettings {
  settings: Record<string, unknown>;
  sources: Record<string, SettingSource>;
}

/**
 * Resolve multiple settings at once
 */
export function resolveBehaviorSettings(options: {
  stored?: Record<string, unknown>;
  env: Record<string, string | undefined>;
}): ResolvedBehaviorSettings {
  const env = options.env;
  const stored = options.stored ?? {};
  
  const settings: Record<string, unknown> = {};
  const sources: Record<string, SettingSource> = {};
  
  for (const def of behaviorSettingRegistry.getAll()) {
    const storedValue = stored[def.key];
    const result = resolveSetting({
      key: def.key,
      stored: storedValue,
      env
    });
    
    settings[def.key] = result.value;
    sources[def.key] = result.source;
  }
  
  return { settings, sources };
}

/**
 * Schema for validating a behavior settings patch
 */
export function createBehaviorSettingsPatchSchema() {
  const shape: Record<string, z.ZodTypeAny> = {};
  
  for (const def of behaviorSettingRegistry.getAll()) {
    switch (def.valueType) {
      case "boolean":
        shape[def.key] = z.boolean().optional();
        break;
      case "string":
        shape[def.key] = z.string().optional();
        break;
      case "number":
        shape[def.key] = z.number().optional();
        break;
      case "json":
        shape[def.key] = z.unknown().optional();
        break;
    }
  }
  
  return z.object(shape).strict();
}

/**
 * Patch type for behavior settings
 */
export type BehaviorSettingsPatch = z.infer<ReturnType<typeof createBehaviorSettingsPatchSchema>>;

/**
 * Merge base settings with a patch
 */
export function mergeBehaviorSettings(base: Record<string, unknown>, patch: BehaviorSettingsPatch): Record<string, unknown> {
  const result = { ...base };
  
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  
  return result;
}