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

const positiveInteger = (allowZero = false) => (value: unknown): number | null => {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(num) && (allowZero ? num >= 0 : num > 0) ? num : null;
};
const nonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
const booleanSetting = (value: unknown): boolean | null => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const raw = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(raw)) return true;
    if (["false", "0", "no", "off"].includes(raw)) return false;
  }
  return null;
};

// SETTINGS-TO-UI D: behavior settings that are safe to edit at instance scope.
// Service addresses and secret names remain deployment/secret-store owned.
const dSettings: Array<{
  key: string;
  envName: string;
  default: unknown;
  section: "channels" | "models";
  validate: (value: unknown) => unknown | null;
}> = [
  { key: "telegramDmConversations", envName: "MYRMIDON_TELEGRAM_DM_CONVERSATIONS", default: "", section: "channels", validate: (value) => typeof value === "string" ? value : null },
  { key: "telegramDmStatus", envName: "MYRMIDON_TELEGRAM_DM_STATUS", default: false, section: "channels", validate: booleanSetting },
  { key: "telegramSplitMaxParts", envName: "MYRMIDON_TELEGRAM_SPLIT_MAX_PARTS", default: 0, section: "channels", validate: positiveInteger(true) },
  { key: "telegramFileLimitBytes", envName: "MYRMIDON_TELEGRAM_FILE_LIMIT_BYTES", default: 10 * 1024 * 1024, section: "channels", validate: positiveInteger() },
  { key: "paperclipAttachmentMaxBytes", envName: "PAPERCLIP_ATTACHMENT_MAX_BYTES", default: 10 * 1024 * 1024, section: "channels", validate: positiveInteger() },
  { key: "chatCrossChannelMessages", envName: "MYRMIDON_CHAT_CROSS_CHANNEL_MESSAGES", default: 12, section: "channels", validate: positiveInteger(true) },
  { key: "chatCrossChannelMessageChars", envName: "MYRMIDON_CHAT_CROSS_CHANNEL_MESSAGE_CHARS", default: 600, section: "channels", validate: positiveInteger(true) },
  { key: "chatCrossChannelTotalChars", envName: "MYRMIDON_CHAT_CROSS_CHANNEL_TOTAL_CHARS", default: 4000, section: "channels", validate: positiveInteger(true) },
  { key: "chatCrossChannelLookbackHours", envName: "MYRMIDON_CHAT_CROSS_CHANNEL_LOOKBACK_HOURS", default: 168, section: "channels", validate: positiveInteger(true) },
  { key: "chatReconcileIntervalMs", envName: "MYRMIDON_CHAT_RECONCILE_INTERVAL_MS", default: null, section: "channels", validate: (value) => value === null ? null : positiveInteger()(value) },
  { key: "litellmCostIntervalSec", envName: "MYRMIDON_LITELLM_COST_INTERVAL_SEC", default: 30, section: "models", validate: positiveInteger() },
  { key: "botCompressionThresholdTokens", envName: "MYRMIDON_BOT_COMPRESSION_THRESHOLD_TOKENS", default: 100000, section: "models", validate: positiveInteger(true) },
  { key: "botModelContextLengths", envName: "MYRMIDON_BOT_MODEL_CONTEXT_LENGTH", default: {}, section: "models", validate: (value) => typeof value === "object" && value !== null ? value : null },
  { key: "botAuxTitleModel", envName: "MYRMIDON_BOT_AUX_TITLE_MODEL", default: "", section: "models", validate: nonEmptyString },
  { key: "botAuxCompressionModel", envName: "MYRMIDON_BOT_AUX_COMPRESSION_MODEL", default: "", section: "models", validate: nonEmptyString },
  { key: "botHelperModel", envName: "MYRMIDON_BOT_HELPER_MODEL", default: "", section: "models", validate: nonEmptyString },
  { key: "ctoChatModel", envName: "MYRMIDON_CTO_CHAT_MODEL", default: "dashscope-qwen-flash", section: "models", validate: nonEmptyString },
  { key: "ctoChatTimeoutSec", envName: "MYRMIDON_CTO_CHAT_TIMEOUT_SEC", default: 90, section: "models", validate: positiveInteger() },
  { key: "ctoChatMaxTasks", envName: "MYRMIDON_CTO_CHAT_MAX_TASKS", default: 8, section: "models", validate: positiveInteger() },
  { key: "evalsModel", envName: "MYRMIDON_EVALS_MODEL", default: "", section: "models", validate: nonEmptyString },
  { key: "evalsTimeoutSec", envName: "MYRMIDON_EVALS_TIMEOUT_SEC", default: 90, section: "models", validate: positiveInteger() },
  { key: "evalsLangfuseExport", envName: "MYRMIDON_EVALS_LANGFUSE", default: false, section: "models", validate: booleanSetting },
  { key: "ocrBackend", envName: "MYRMIDON_OCR_BACKEND", default: "ragflow", section: "models", validate: (value) => value === "ragflow" || value === "litellm" ? value : null },
  { key: "ocrModel", envName: "MYRMIDON_OCR_MODEL", default: "", section: "models", validate: nonEmptyString },
  { key: "ocrMaxBytes", envName: "MYRMIDON_OCR_MAX_BYTES", default: 32 * 1024 * 1024, section: "models", validate: positiveInteger() },
  { key: "ocrMaxPages", envName: "MYRMIDON_OCR_MAX_PAGES", default: 500, section: "models", validate: positiveInteger() },
  { key: "ocrMaxChars", envName: "MYRMIDON_OCR_MAX_CHARS", default: 2_000_000, section: "models", validate: positiveInteger() },
  { key: "ocrTimeoutSec", envName: "MYRMIDON_OCR_TIMEOUT_SEC", default: 120, section: "models", validate: positiveInteger() },
];
for (const setting of dSettings) {
  behaviorSettingRegistry.register({
    key: setting.key,
    envName: setting.envName,
    default: setting.default,
    scope: "instance",
    section: setting.section,
    valueType: typeof setting.default === "boolean" ? "boolean" : typeof setting.default === "number" ? "number" : "string",
    validate: setting.validate,
  });
}


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