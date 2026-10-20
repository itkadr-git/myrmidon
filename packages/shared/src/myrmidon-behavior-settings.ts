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
  /** Human-readable description of the setting */
  description?: string;
}

/** Registry of all behavior settings */
export class BehaviorSettingRegistry {
  private settings: Map<string, BehaviorSettingDef> = new Map();

  register<T>(definition: BehaviorSettingDef<T>): void {
    if (this.settings.has(definition.key)) {
      throw new Error(`Setting with key '${definition.key}' is already registered`);
    }
    this.settings.set(definition.key, definition as BehaviorSettingDef);
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

export function validateBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(lower)) return true;
    if (["false", "0", "no", "off"].includes(lower)) return false;
  }
  return null;
}

export function validateInteger(value: unknown, min?: number, max?: number): number | null {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(num)) return null;
  if (min !== undefined && num < min) return null;
  if (max !== undefined && num > max) return null;
  return num;
}

export function validateNumber(value: unknown, min?: number, max?: number): number | null {
  const num = typeof value === "number" ? value : Number(value);
  if (typeof num !== "number" || Number.isNaN(num)) return null;
  if (min !== undefined && num < min) return null;
  if (max !== undefined && num > max) return null;
  return num;
}

export function validateString(value: unknown, allowed?: readonly string[]): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (allowed && !allowed.includes(trimmed)) return null;
  return trimmed;
}

// Development & Runtime Base Settings
behaviorSettingRegistry.register({
  key: "debug_mode",
  envName: "MYRMIDON_DEBUG_MODE",
  default: false,
  scope: "instance",
  section: "development",
  valueType: "boolean",
  description: "Debug mode for verbose diagnostics and internal logs",
  validate: validateBoolean,
});

behaviorSettingRegistry.register({
  key: "max_concurrent_agents",
  envName: "MYRMIDON_MAX_CONCURRENT_AGENTS",
  default: 5,
  scope: "instance",
  section: "performance",
  valueType: "number",
  description: "Maximum number of concurrent agents executing tasks",
  validate: (v) => validateInteger(v, 1),
});

behaviorSettingRegistry.register({
  key: "default_timeout_seconds",
  envName: "MYRMIDON_DEFAULT_TIMEOUT_SECONDS",
  default: 300,
  scope: "instance",
  section: "runtime",
  valueType: "number",
  description: "Default timeout in seconds for agent tool executions",
  validate: (v) => validateInteger(v, 1),
});

// OPE-8146 Registry: Kill-switches & Safety Guards (S-size portable)
behaviorSettingRegistry.register({
  key: "autonomy_level",
  envName: "MYRMIDON_AUTONOMY_LEVEL",
  default: "full",
  scope: "instance",
  section: "kill_switches",
  valueType: "string",
  description: "Global autonomy level: none, lead_only, full",
  validate: (v) => validateString(v, ["none", "lead_only", "full"]),
});

behaviorSettingRegistry.register({
  key: "run_stop_signal_mode",
  envName: "MYRMIDON_RUN_STOP_SIGNAL_MODE",
  default: "graceful",
  scope: "instance",
  section: "kill_switches",
  valueType: "string",
  description: "Run termination signal mode: disabled, graceful, immediate",
  validate: (v) => validateString(v, ["disabled", "graceful", "immediate"]),
});

behaviorSettingRegistry.register({
  key: "pause_drain_enabled",
  envName: "MYRMIDON_PAUSE_DRAIN_ENABLED",
  default: true,
  scope: "instance",
  section: "kill_switches",
  valueType: "boolean",
  description: "Graceful drain of active runs when pause is requested",
  validate: validateBoolean,
});

behaviorSettingRegistry.register({
  key: "pause_drain_grace_sec",
  envName: "MYRMIDON_PAUSE_DRAIN_GRACE_SEC",
  default: 120,
  scope: "instance",
  section: "kill_switches",
  valueType: "number",
  description: "Grace period in seconds before active runs are terminated on drain",
  validate: (v) => validateInteger(v, 0),
});

behaviorSettingRegistry.register({
  key: "pause_resume_wake_batch_size",
  envName: "MYRMIDON_PAUSE_RESUME_WAKE_BATCH_SIZE",
  default: 5,
  scope: "instance",
  section: "kill_switches",
  valueType: "number",
  description: "Batch size for staggered wakes when resuming from pause",
  validate: (v) => validateInteger(v, 1),
});

behaviorSettingRegistry.register({
  key: "pause_resume_wake_batch_pause_ms",
  envName: "MYRMIDON_PAUSE_RESUME_WAKE_BATCH_PAUSE_MS",
  default: 1000,
  scope: "instance",
  section: "kill_switches",
  valueType: "number",
  description: "Pause in milliseconds between wake batches when resuming",
  validate: (v) => validateInteger(v, 0),
});

behaviorSettingRegistry.register({
  key: "stranded_autopolicy_enabled",
  envName: "MYRMIDON_STRANDED_AUTOPOLICY_ENABLED",
  default: true,
  scope: "instance",
  section: "escalation",
  valueType: "boolean",
  description: "Automated retry policy for stranded tasks before escalating to lead",
  validate: validateBoolean,
});

behaviorSettingRegistry.register({
  key: "stranded_autopolicy_retries_per_day",
  envName: "MYRMIDON_STRANDED_AUTOPOLICY_RETRIES_PER_DAY",
  default: 3,
  scope: "instance",
  section: "escalation",
  valueType: "number",
  description: "Maximum retries per day per stranded task before lead escalation",
  validate: (v) => validateInteger(v, 1, 10),
});

behaviorSettingRegistry.register({
  key: "write_lock_requires_live_run",
  envName: "MYRMIDON_WRITE_LOCK_REQUIRES_LIVE_RUN",
  default: true,
  scope: "instance",
  section: "concurrency",
  valueType: "boolean",
  description: "Require confirmed live run for issue write locks (409 on stale)",
  validate: validateBoolean,
});

behaviorSettingRegistry.register({
  key: "pause_guard_enabled",
  envName: "MYRMIDON_PAUSE_GUARD_ENABLED",
  default: true,
  scope: "instance",
  section: "pause_guard",
  valueType: "boolean",
  description: "Alert operator when an agent has remained paused for too long",
  validate: validateBoolean,
});

behaviorSettingRegistry.register({
  key: "pause_guard_threshold_days",
  envName: "MYRMIDON_PAUSE_GUARD_THRESHOLD_DAYS",
  default: 7,
  scope: "instance",
  section: "pause_guard",
  valueType: "number",
  description: "Days on pause before triggering pause guard alert",
  validate: (v) => validateInteger(v, 1),
});

behaviorSettingRegistry.register({
  key: "guardrail_injection_enabled",
  envName: "MYRMIDON_GUARDRAIL_INJECTION_ENABLED",
  default: true,
  scope: "instance",
  section: "guardrails",
  valueType: "boolean",
  description: "Analyze incoming queue prompts for prompt injection signals",
  validate: validateBoolean,
});

behaviorSettingRegistry.register({
  key: "guardrail_injection_action",
  envName: "MYRMIDON_GUARDRAIL_INJECTION_ACTION",
  default: "tag",
  scope: "instance",
  section: "guardrails",
  valueType: "string",
  description: "Action on detected prompt injection: tag or block",
  validate: (v) => validateString(v, ["tag", "block"]),
});

behaviorSettingRegistry.register({
  key: "blocked_loop_max_returns",
  envName: "MYRMIDON_BLOCKED_LOOP_MAX_RETURNS",
  default: 3,
  scope: "instance",
  section: "escalation",
  valueType: "number",
  description: "Maximum times an issue can return to blocked before alerting lead",
  validate: (v) => validateInteger(v, 1, 10),
});

behaviorSettingRegistry.register({
  key: "stale_block_enabled",
  envName: "MYRMIDON_STALE_BLOCK_ENABLED",
  default: true,
  scope: "instance",
  section: "escalation",
  valueType: "boolean",
  description: "Monitor issues that have remained blocked without updates",
  validate: validateBoolean,
});

behaviorSettingRegistry.register({
  key: "task_pr_sync_wake_guard",
  envName: "MYRMIDON_TASK_PR_SYNC_WAKE_GUARD",
  default: true,
  scope: "instance",
  section: "task_pr_sync",
  valueType: "boolean",
  description: "Prevent starting runs when all PRs for the task are already merged",
  validate: validateBoolean,
});

// OPE-8146 Registry: Swarm, Caste & Scent (S-size portable)
behaviorSettingRegistry.register({
  key: "swarm_claim_enabled",
  envName: "MYRMIDON_SWARM_CLAIM_ENABLED",
  default: false,
  scope: "instance",
  section: "swarm",
  valueType: "boolean",
  description: "Autonomous task pickup and claim by swarm agents",
  validate: validateBoolean,
});

behaviorSettingRegistry.register({
  key: "swarm_lease_ttl_sec",
  envName: "MYRMIDON_SWARM_LEASE_TTL_SEC",
  default: 120,
  scope: "instance",
  section: "swarm",
  valueType: "number",
  description: "TTL in seconds for temporary task leases claimed by swarm",
  validate: (v) => validateInteger(v, 1),
});

behaviorSettingRegistry.register({
  key: "swarm_max_active_tasks",
  envName: "MYRMIDON_SWARM_MAX_ACTIVE_TASKS",
  default: 1,
  scope: "instance",
  section: "swarm",
  valueType: "number",
  description: "Maximum active concurrent claimed tasks per agent in swarm mode",
  validate: (v) => validateInteger(v, 1, 5),
});

behaviorSettingRegistry.register({
  key: "swarm_taskless_gate",
  envName: "MYRMIDON_SWARM_TASKLESS_GATE",
  default: true,
  scope: "instance",
  section: "swarm",
  valueType: "boolean",
  description: "Gate preventing swarm agent wakes when no unassigned tasks exist",
  validate: validateBoolean,
});

behaviorSettingRegistry.register({
  key: "swarm_cooling_base_sec",
  envName: "MYRMIDON_SWARM_COOLING_BASE_SEC",
  default: 30,
  scope: "instance",
  section: "swarm",
  valueType: "number",
  description: "Base cooling period in seconds for exponential backoff on unassigned tasks",
  validate: (v) => validateInteger(v, 1),
});

behaviorSettingRegistry.register({
  key: "swarm_scent_enabled",
  envName: "MYRMIDON_SWARM_SCENT_ENABLED",
  default: false,
  scope: "instance",
  section: "swarm_scent",
  valueType: "boolean",
  description: "Enable scent-based similarity matching for swarm task pickup",
  validate: validateBoolean,
});

behaviorSettingRegistry.register({
  key: "swarm_scent_model",
  envName: "MYRMIDON_SWARM_SCENT_MODEL",
  default: "gpt-4o-mini",
  scope: "instance",
  section: "swarm_scent",
  valueType: "string",
  description: "LLM model name for task scent classification",
  validate: (v) => validateString(v),
});

behaviorSettingRegistry.register({
  key: "swarm_scent_weight_recency",
  envName: "MYRMIDON_SWARM_SCENT_WEIGHT_RECENCY",
  default: 0.3,
  scope: "instance",
  section: "swarm_scent",
  valueType: "number",
  description: "Weight for recency factor in scent calculation (0.0 to 1.0)",
  validate: (v) => validateNumber(v, 0.0, 1.0),
});

behaviorSettingRegistry.register({
  key: "swarm_scent_weight_similarity",
  envName: "MYRMIDON_SWARM_SCENT_WEIGHT_SIMILARITY",
  default: 0.5,
  scope: "instance",
  section: "swarm_scent",
  valueType: "number",
  description: "Weight for semantic similarity factor in scent calculation (0.0 to 1.0)",
  validate: (v) => validateNumber(v, 0.0, 1.0),
});

behaviorSettingRegistry.register({
  key: "swarm_scent_weight_success",
  envName: "MYRMIDON_SWARM_SCENT_WEIGHT_SUCCESS",
  default: 0.2,
  scope: "instance",
  section: "swarm_scent",
  valueType: "number",
  description: "Weight for past success factor in scent calculation (0.0 to 1.0)",
  validate: (v) => validateNumber(v, 0.0, 1.0),
});

// OPE-8146 Registry: Agent Context & Continuation Limits (S-size portable)
behaviorSettingRegistry.register({
  key: "continuation_history_limit",
  envName: "MYRMIDON_CONTINUATION_HISTORY_LIMIT",
  default: 30,
  scope: "instance",
  section: "agent_context",
  valueType: "number",
  description: "Number of history steps included in continuation context",
  validate: (v) => validateInteger(v, 1, 100),
});

behaviorSettingRegistry.register({
  key: "continuation_history_chars",
  envName: "MYRMIDON_CONTINUATION_HISTORY_CHARS",
  default: 24000,
  scope: "instance",
  section: "agent_context",
  valueType: "number",
  description: "Character budget for entire continuation history",
  validate: (v) => validateInteger(v, 1000),
});

behaviorSettingRegistry.register({
  key: "continuation_message_max_chars",
  envName: "MYRMIDON_CONTINUATION_MESSAGE_MAX_CHARS",
  default: 12000,
  scope: "instance",
  section: "agent_context",
  valueType: "number",
  description: "Maximum characters allowed per single continuation message",
  validate: (v) => validateInteger(v, 500),
});

behaviorSettingRegistry.register({
  key: "long_task_context_enabled",
  envName: "MYRMIDON_LONG_TASK_CONTEXT_ENABLED",
  default: true,
  scope: "instance",
  section: "agent_context",
  valueType: "boolean",
  description: "Automatic context compaction/reset for long-running tasks",
  validate: validateBoolean,
});

behaviorSettingRegistry.register({
  key: "long_task_context_reset_pct",
  envName: "MYRMIDON_LONG_TASK_CONTEXT_RESET_PCT",
  default: 70,
  scope: "instance",
  section: "agent_context",
  valueType: "number",
  description: "Context window utilization percentage triggering compaction",
  validate: (v) => validateInteger(v, 10, 95),
});

behaviorSettingRegistry.register({
  key: "parallel_helpers_max_count",
  envName: "MYRMIDON_PARALLEL_HELPERS_MAX_COUNT",
  default: 5,
  scope: "instance",
  section: "parallel_helpers",
  valueType: "number",
  description: "Maximum subagents/parallel helpers allowed per run",
  validate: (v) => validateInteger(v, 1, 20),
});

behaviorSettingRegistry.register({
  key: "parallel_helpers_default",
  envName: "MYRMIDON_PARALLEL_HELPERS_DEFAULT",
  default: 2,
  scope: "instance",
  section: "parallel_helpers",
  valueType: "number",
  description: "Default helper capacity for new agents",
  validate: (v) => validateInteger(v, 0, 10),
});

behaviorSettingRegistry.register({
  key: "team_liveness_silence_threshold_sec",
  envName: "MYRMIDON_TEAM_LIVENESS_SILENCE_THRESHOLD_SEC",
  default: 600,
  scope: "instance",
  section: "team_liveness",
  valueType: "number",
  description: "Silence duration in seconds before triggering team liveness attention",
  validate: (v) => validateInteger(v, 10),
});

// OPE-8146 Registry: Platform, Reviews & Recovery (S-size portable)
behaviorSettingRegistry.register({
  key: "skip_idle_heartbeats",
  envName: "MYRMIDON_SKIP_IDLE_HEARTBEATS",
  default: false,
  scope: "instance",
  section: "scheduler",
  valueType: "boolean",
  description: "Skip idle timer heartbeat wakes when agent has no active tasks",
  validate: validateBoolean,
});

behaviorSettingRegistry.register({
  key: "auto_resume_from_error",
  envName: "MYRMIDON_AUTO_RESUME_FROM_ERROR",
  default: true,
  scope: "instance",
  section: "recovery",
  valueType: "boolean",
  description: "Automatically resume tasks from error status when environment is repaired",
  validate: validateBoolean,
});

behaviorSettingRegistry.register({
  key: "review_routing_enabled",
  envName: "MYRMIDON_REVIEW_ROUTING_ENABLED",
  default: true,
  scope: "company",
  section: "reviews",
  valueType: "boolean",
  description: "Automated PR reviewer routing (adm-dev-review-8 / adm-dev-review-9)",
  validate: validateBoolean,
});

behaviorSettingRegistry.register({
  key: "review_rework_enabled",
  envName: "MYRMIDON_REVIEW_REWORK_ENABLED",
  default: true,
  scope: "instance",
  section: "reviews",
  valueType: "boolean",
  description: "Rework return cycle on negative review verdict",
  validate: validateBoolean,
});

behaviorSettingRegistry.register({
  key: "budget_limits_signal_only",
  envName: "MYRMIDON_BUDGET_LIMITS_SIGNAL_ONLY",
  default: true,
  scope: "instance",
  section: "budget",
  valueType: "boolean",
  description: "When enabled, budget limits emit warnings without pausing runs",
  validate: validateBoolean,
});

behaviorSettingRegistry.register({
  key: "model_fallback_signal_enabled",
  envName: "MYRMIDON_MODEL_FALLBACK_SIGNAL_ENABLED",
  default: true,
  scope: "instance",
  section: "models",
  valueType: "boolean",
  description: "Emit operator signal when LLM fallback rate exceeds threshold",
  validate: validateBoolean,
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
export function createBehaviorSettingsPatchSchema(scope?: SettingScope) {
  const shape: Record<string, z.ZodTypeAny> = {};
  const defs = scope
    ? behaviorSettingRegistry.getAll().filter((def) => def.scope === scope)
    : behaviorSettingRegistry.getAll();
  
  for (const def of defs) {
    let schema: z.ZodTypeAny;
    switch (def.valueType) {
      case "boolean":
        schema = z.boolean();
        break;
      case "string":
        schema = z.string();
        break;
      case "number":
        schema = z.number();
        break;
      case "json":
        schema = z.unknown();
        break;
    }
    shape[def.key] = schema
      .refine((val) => def.validate(val) !== null, {
        message: `Invalid value for setting '${def.key}'`,
      })
      .optional();
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