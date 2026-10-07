// packages/shared/src/myrmidon-debate-castes.ts
//
// myrmidon(1.7-DEBATE-ASYM-B): the debate configuration of one caste.
//
// Part A (1.7-DEBATE-ASYM-A) configures the engine once for the instance. Part
// B gives every caste its own knobs, because the castes do different work: the
// marketing caste argues about a campaign, the engineering caste about a
// migration, and the free models that fit one are not automatically the right
// pair for the other.
//
// What a caste may set: whether debates run for it at all (`enabled`), the
// model of each role, the extra guidance each role argues from, the number of
// rounds (never more than three, the owner rule) and the token ceiling. The
// override lives in the same stored value as the instance configuration —
// `general.debate.castes.<key>` — so there is no migration and the existing
// preserve key keeps it alive across vendor writes of `instance_settings`.
// Every entry is pinned to the company it was written for: castes are
// company-scoped rows, so an entry whose `companyId` does not match the caste
// being resolved is inert (it is reported, never applied).
//
// Precedence for a caste: the caste entry, then the instance configuration
// (stored row, then `MYRMIDON_DEBATE_CONFIG`, then the built-in default). The
// cross-family rule is re-checked on the MERGED configuration, so a caste that
// overrides only the critic cannot slip a same-family judge past the rule.
//
// The built-in pole prompts and the critic's missed-error penalty are not
// configurable: a caste's guidance is appended to them (see
// `composeRoleSystemPrompt`), never written instead of them.

import { z } from "zod";
import {
  DEBATE_CASTES_KEY,
  DEBATE_CUSTOM_PROMPT_MAX_LENGTH,
  DEBATE_MAX_ROUNDS_LIMIT,
  debateFamilyProblem,
  debateSettingsSchema,
  type DebatePromptOverrides,
  type DebateRole,
  type DebateSettings,
  type DebateSettingsResolution,
} from "./myrmidon-debate.js";

export { DEBATE_CASTES_KEY };

/** Caste keys are the role strings of the caste directory (and of `agent.role`). */
export const CASTE_DEBATE_KEY_MAX_LENGTH = 64;

/**
 * Debates are on for a caste that has no entry of its own: the instance
 * configuration is already an explicit operator choice (free models by
 * default), and the per-caste switch exists to take a caste OUT — a caste
 * whose work should not spend gateway calls, or one being piloted later. The
 * resolution reports `enabledSource: "default"` so the UI can say so.
 */
export const DEBATE_CASTE_ENABLED_DEFAULT = true;

const casteKeySchema = z.string().trim().min(1).max(CASTE_DEBATE_KEY_MAX_LENGTH);

/** Validate a caste key before anything is resolved for it. */
export function parseCasteDebateKey(raw: string): { ok: true; key: string } | { ok: false; problem: string } {
  const parsed = casteKeySchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      problem: `"${raw}" is not a valid caste key (1..${CASTE_DEBATE_KEY_MAX_LENGTH} characters)`,
    };
  }
  return { ok: true, key: parsed.data };
}

/** A role override reuses part A's role schema, so the two can never drift. */
const roleOverrideSchema = debateSettingsSchema.shape.generator;

/** Per-role extra guidance: appended to the built-in pole, never instead of it. */
export const debatePromptsSchema = z
  .object({
    generator: z.string().trim().min(1).max(DEBATE_CUSTOM_PROMPT_MAX_LENGTH).optional(),
    critic: z.string().trim().min(1).max(DEBATE_CUSTOM_PROMPT_MAX_LENGTH).optional(),
    judge: z.string().trim().min(1).max(DEBATE_CUSTOM_PROMPT_MAX_LENGTH).optional(),
  })
  .strict();

export type CasteDebatePrompts = z.infer<typeof debatePromptsSchema>;

/**
 * The stored per-caste entry. `companyId` is written by the server (never by
 * the caller) — it is what makes a shared instance-settings map safe for
 * company-scoped castes.
 */
export const casteDebateOverrideSchema = z
  .object({
    companyId: z.string().trim().min(1).max(64),
    enabled: z.boolean().optional(),
    generator: roleOverrideSchema.optional(),
    critic: roleOverrideSchema.optional(),
    judge: roleOverrideSchema.optional(),
    rounds: z.number().int().min(1).max(DEBATE_MAX_ROUNDS_LIMIT).optional(),
    tokenCeiling: z.number().int().min(1000).max(10_000_000).optional(),
    prompts: debatePromptsSchema.optional(),
  })
  .strict();

export type CasteDebateOverride = z.infer<typeof casteDebateOverrideSchema>;

/** What the PATCH body may carry: everything but the pinned company id. */
export const casteDebatePatchSchema = casteDebateOverrideSchema.omit({ companyId: true }).strict();
export type CasteDebatePatch = z.infer<typeof casteDebatePatchSchema>;

export type CasteDebateResolution = {
  casteKey: string;
  /** Whether a debate may run for this caste right now. */
  enabled: boolean;
  /** Where the switch came from: the caste entry, or the built-in default. */
  enabledSource: "caste" | "default";
  /** The configuration a run would use; null when nothing usable resolves. */
  settings: DebateSettings | null;
  /**
   * Where the roles/rounds/ceiling came from: the caste entry ("caste") or the
   * instance level (its own source). Null when no configuration resolved.
   */
  source: DebateSettingsResolution["source"] | "caste";
  /** The instance level's source, so the UI can show what a caste inherits. */
  instanceSource: DebateSettingsResolution["source"];
  /** The knobs this caste overrides, in a stable order. */
  overrides: string[];
  /** The extra guidance per role, if any. */
  prompts: DebatePromptOverrides;
  /** Why the merged configuration cannot run (family rule, malformed entry). */
  problem: string | null;
};

export type CasteDebateOverrideParse = { ok: true; override: CasteDebateOverride } | { ok: false; problem: string };

/** Parse one stored override entry; a malformed entry is a reported problem. */
export function parseCasteDebateOverride(raw: unknown): CasteDebateOverrideParse {
  const parsed = casteDebateOverrideSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      problem: `the caste debate entry is malformed: ${parsed.error.issues
        .map((i) => `${i.path.join(".")} ${i.message}`)
        .join("; ")}`,
    };
  }
  return { ok: true, override: parsed.data };
}

/**
 * The override entry for one caste out of the stored map. An entry written for
 * another company is NOT applied — castes are company-scoped, and a stale or
 * foreign entry must not silently drive the debate of a same-named caste
 * elsewhere on the instance.
 */
export function pickCasteDebateOverride(
  map: unknown,
  options: { companyId: string; casteKey: string },
): { override: CasteDebateOverride | null; problem: string | null; foreign: string | null } {
  const key = options.casteKey.trim();
  if (!casteKeySchema.safeParse(key).success) {
    return { override: null, problem: `"${options.casteKey}" is not a valid caste key`, foreign: null };
  }
  if (typeof map !== "object" || map === null || Array.isArray(map)) {
    return { override: null, problem: null, foreign: null };
  }
  const raw = (map as Record<string, unknown>)[key];
  if (raw === undefined || raw === null) return { override: null, problem: null, foreign: null };
  const parsed = parseCasteDebateOverride(raw);
  if (!parsed.ok) return { override: null, problem: parsed.problem, foreign: null };
  if (parsed.override.companyId !== options.companyId) {
    return {
      override: null,
      problem: null,
      foreign: `the stored debate entry for caste "${key}" belongs to another company and was ignored`,
    };
  }
  return { override: parsed.override, problem: null, foreign: null };
}

/** The knob names an entry overrides, in a stable order (for the UI and the log). */
export function casteDebateOverrideKeys(override: CasteDebateOverride | null): string[] {
  if (!override) return [];
  const keys: string[] = [];
  if (override.enabled !== undefined) keys.push("enabled");
  for (const role of ["generator", "critic", "judge"] as const) {
    if (override[role] !== undefined) keys.push(role);
  }
  if (override.rounds !== undefined) keys.push("rounds");
  if (override.tokenCeiling !== undefined) keys.push("tokenCeiling");
  if (override.prompts && Object.keys(override.prompts).length > 0) keys.push("prompts");
  return keys;
}

/** The custom guidance map out of an entry (roles without guidance are dropped). */
export function casteDebatePrompts(override: CasteDebateOverride | null): DebatePromptOverrides {
  const prompts = override?.prompts;
  if (!prompts) return {};
  const out: DebatePromptOverrides = {};
  for (const role of ["generator", "critic", "judge"] as const) {
    const text = prompts[role];
    if (typeof text === "string" && text.trim().length > 0) out[role] = text.trim();
  }
  return out;
}

/**
 * The configuration a debate of this caste would run with, and where every
 * part of it came from. The instance resolution is part A's result (stored
 * row → forced env → default); the caste entry is laid over it field by field,
 * so a caste that sets only the critic keeps the instance generator, judge,
 * rounds and ceiling.
 *
 * Nothing is silently degraded here: a malformed entry, a malformed instance
 * value and a merged configuration that breaks the asymmetry rule all come
 * back as `problem` with `settings: null`, and the caller refuses the run.
 */
export function resolveCasteDebateSettings(input: {
  casteKey: string;
  override: CasteDebateOverride | null;
  instance: DebateSettingsResolution;
  /** Problem reported by the storage layer for this caste (foreign/parse). */
  entryProblem?: string | null;
}): CasteDebateResolution {
  const override = input.override;
  const overrides = casteDebateOverrideKeys(override);
  const prompts = casteDebatePrompts(override);
  const enabled = override?.enabled ?? DEBATE_CASTE_ENABLED_DEFAULT;
  const enabledSource: CasteDebateResolution["enabledSource"] = override?.enabled === undefined ? "default" : "caste";
  const base = input.instance.settings;

  const problemOf = (problem: string): CasteDebateResolution => ({
    casteKey: input.casteKey,
    enabled,
    enabledSource,
    settings: null,
    source: null,
    instanceSource: input.instance.source,
    overrides,
    prompts,
    problem,
  });

  if (input.entryProblem) return problemOf(input.entryProblem);
  if (!base) {
    return problemOf(input.instance.problem ?? "no debate configuration is available on this instance");
  }

  const merged: DebateSettings = {
    generator: override?.generator ?? base.generator,
    critic: override?.critic ?? base.critic,
    judge: override?.judge ?? base.judge,
    rounds: override?.rounds ?? base.rounds,
    tokenCeiling: override?.tokenCeiling ?? base.tokenCeiling,
  };
  const inheritsEverything = !["generator", "critic", "judge", "rounds", "tokenCeiling"].some((key) =>
    overrides.includes(key),
  );
  const source: CasteDebateResolution["source"] = inheritsEverything ? input.instance.source : "caste";
  const collision = debateFamilyProblem(merged);
  if (collision) return problemOf(collision);

  return {
    casteKey: input.casteKey,
    enabled,
    enabledSource,
    settings: merged,
    source,
    instanceSource: input.instance.source,
    overrides,
    prompts,
    problem: null,
  };
}

/**
 * One line for the UI caption and the activity log: what a debate of this
 * caste runs with, and where it came from. No secret values — model names,
 * counts and sources only.
 */
export function renderCasteDebateSummary(resolution: CasteDebateResolution): string {
  const parts: string[] = [`caste ${resolution.casteKey}`, resolution.enabled ? "on" : "off"];
  if (resolution.settings) {
    const s = resolution.settings;
    parts.push(`generator=${s.generator.model}`, `critic=${s.critic.model}`, `judge=${s.judge.model}`);
    parts.push(`rounds=${s.rounds ?? "default"}`, `tokenCeiling=${s.tokenCeiling ?? "default"}`);
  }
  parts.push(`enabled from ${resolution.enabledSource}`);
  parts.push(`config from ${resolution.source ?? "nothing"}`);
  if (resolution.overrides.length > 0) parts.push(`override: ${resolution.overrides.join(", ")}`);
  if (resolution.problem) parts.push(`problem: ${resolution.problem}`);
  return parts.join(" · ");
}

/**
 * Which roles a caste's custom guidance touches — the same list the result
 * document and the activity log carry.
 */
export function customPromptRoles(prompts: DebatePromptOverrides): DebateRole[] {
  return (["generator", "critic", "judge"] as const).filter((role) => {
    const text = prompts[role];
    return typeof text === "string" && text.trim().length > 0;
  });
}

/** Whether a run of this caste may start; the caller maps `reason` to its refusal. */
export function casteDebateGate(resolution: CasteDebateResolution): { ok: true } | { ok: false; code: string; reason: string } {
  if (!resolution.enabled) {
    return {
      ok: false,
      code: "debate_caste_disabled",
      reason: `debates are switched off for caste "${resolution.casteKey}" — turn them on in the caste settings`,
    };
  }
  if (resolution.problem || !resolution.settings) {
    return {
      ok: false,
      code: "debate_config_rejected",
      reason: resolution.problem ?? `caste "${resolution.casteKey}" has no usable debate configuration`,
    };
  }
  return { ok: true };
}

/** Convenience for the server: the stored map out of a raw value (part A helper). */
export { readStoredCastes } from "./myrmidon-debate.js";