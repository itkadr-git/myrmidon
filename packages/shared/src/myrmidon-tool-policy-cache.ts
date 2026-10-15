import { z } from "zod";

/**
 * Tool gateway policy cache (DB-PERF-C-P4) instance setting.
 *
 * The tool gateway decides access on every `tools/list` and every tool call,
 * and each decision used to read `tool_profile_bindings`, `tool_profiles`,
 * `tool_profile_entries` and the enabled `tool_policies` from the database.
 * `server/src/myrmidon/tool-policy-cache/` serves those four row sets from an
 * in-process cache keyed by company; this setting is its TTL.
 *
 * Stored in `instance_settings.general.toolPolicyCache`, changed from
 * `PATCH /api/myrmidon/tool-policy-cache`. The server re-reads the row on every
 * cache access, so a change applies without a restart. `ttlMs: 0` switches the
 * cache off — every read goes to the database, so the query set of the gateway
 * is the one it had before the cache existed.
 */
export const TOOL_POLICY_CACHE_SETTINGS_KEY = "toolPolicyCache";

/** Default TTL (30 s): long enough to absorb a burst of gateway calls, short enough to miss by hand. */
export const TOOL_POLICY_CACHE_DEFAULT_TTL_MS = 30_000;
/** `0` is not a floor but the switch: the cache is off and every read is a fresh query. */
export const TOOL_POLICY_CACHE_MIN_TTL_MS = 0;
/** Five minutes — the ceiling an operator may ask for; a stale access decision lives no longer. */
export const TOOL_POLICY_CACHE_MAX_TTL_MS = 300_000;

export interface ToolPolicyCacheSettings {
  /** Milliseconds a cached snapshot is served; absent means the default. */
  ttlMs?: number;
}

export const toolPolicyCacheSettingsSchema = z
  .object({
    ttlMs: z
      .number()
      .int()
      .min(TOOL_POLICY_CACHE_MIN_TTL_MS)
      .max(TOOL_POLICY_CACHE_MAX_TTL_MS)
      .optional(),
  })
  .strict();

/** Body of `PATCH /api/myrmidon/tool-policy-cache`: `null` clears the field (back to the default). */
export const patchToolPolicyCacheSettingsSchema = z
  .object({
    ttlMs: z
      .number()
      .int()
      .min(TOOL_POLICY_CACHE_MIN_TTL_MS)
      .max(TOOL_POLICY_CACHE_MAX_TTL_MS)
      .nullable()
      .optional(),
  })
  .strict();

export type PatchToolPolicyCacheSettings = z.infer<typeof patchToolPolicyCacheSettingsSchema>;

/**
 * Lenient read of a stored value: unknown shapes and invalid fields are
 * dropped, never thrown, so a damaged row cannot take the tool gateway down.
 */
export function normalizeToolPolicyCacheSettings(raw: unknown): ToolPolicyCacheSettings {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const value = raw as Record<string, unknown>;
  const out: ToolPolicyCacheSettings = {};
  const ttl = toolPolicyCacheSettingsSchema.shape.ttlMs.safeParse(value.ttlMs);
  if (ttl.success) out.ttlMs = ttl.data;
  return out;
}

/**
 * The TTL in force: the stored value, or the default when it is absent. The
 * value is validated by the schema on the way in; a value that slipped past it
 * (an older row, a hand-edited document) is clamped into range rather than
 * trusted, so the hot path can never be handed a `NaN` or a negative window.
 */
export function resolveToolPolicyCacheTtlMs(settings: ToolPolicyCacheSettings): number {
  const stored = settings.ttlMs;
  if (stored === undefined) return TOOL_POLICY_CACHE_DEFAULT_TTL_MS;
  if (!Number.isFinite(stored)) return TOOL_POLICY_CACHE_DEFAULT_TTL_MS;
  if (stored <= TOOL_POLICY_CACHE_MIN_TTL_MS) return TOOL_POLICY_CACHE_MIN_TTL_MS;
  return Math.min(stored, TOOL_POLICY_CACHE_MAX_TTL_MS);
}

/** Apply a PATCH body to stored settings: `null` removes the field. */
export function applyToolPolicyCachePatch(
  stored: ToolPolicyCacheSettings,
  patch: PatchToolPolicyCacheSettings,
): ToolPolicyCacheSettings {
  const next: Record<string, unknown> = { ...stored };
  if (patch.ttlMs !== undefined) {
    if (patch.ttlMs === null) delete next.ttlMs;
    else next.ttlMs = patch.ttlMs;
  }
  return next as ToolPolicyCacheSettings;
}