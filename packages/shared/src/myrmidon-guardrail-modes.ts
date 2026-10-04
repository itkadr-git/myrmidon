// packages/shared/src/myrmidon-guardrail-modes.ts
//
// myrmidon(1.7-GRD-MODES): the shared contract of the guardrail enforcement
// modes (OPE-4167). For every guardrail rule the interface chooses what a hit
// does: block (refuse with a reason), mask (replace the matched span), or
// flag-only (journal the event, change nothing).
//
// The mode is resolved per agent with inheritance:
//
//   agent override > caste (role) override > company override > default
//
// where the default of every rule is flag-only (the 1.6.1 behavior). A rule
// has no setting stored at all until an operator writes one, so a fresh
// install resolves everything to flag-only.
//
// Storage lives in `instance_settings.general.guardrailModes` (the same rule
// wipLimit and the autonomy matrix follow), so a mode change takes effect on
// the next guardrail evaluation without a restart. The only env variable is
// a forced override an operator sets deliberately during an incident:
// `MYRMIDON_GUARDRAILS_MODE_FORCE` pins every rule to one mode; unset or
// malformed means "no force" (a typo never silently rewrites policy).
//
// This module is pure: no I/O, no database, no env access — the server reads
// the env and passes the value in, the UI validates a payload before sending.

import { z } from "zod";

// --- rules and modes -------------------------------------------------------

/**
 * The guardrail rules the 1.6.1 base layer evaluates. The list is closed for
 * 1.7: `secret` and `pii` are the output detectors of part A, `injection` is
 * the input flag of part B. A later rule joins this list, never the raw
 * detector subtype — the mode is set per rule family.
 */
export const GUARDRAIL_RULES = ["secret", "pii", "injection"] as const;
export type GuardrailRule = (typeof GUARDRAIL_RULES)[number];

/**
 * What a hit does.
 *
 * - `flag` — journal the event; the text and the run continue unchanged
 *   (the default, and the whole 1.6.1 behavior).
 * - `mask` — replace every matched span with a neutral placeholder before
 *   the text continues downstream; the event is journaled as masked.
 * - `block` — refuse with a reason: the run output is replaced by a refusal,
 *   or the untrusted input is never handed to the run; the event is
 *   journaled as blocked.
 */
export const GUARDRAIL_MODES = ["flag", "mask", "block"] as const;
export type GuardrailMode = (typeof GUARDRAIL_MODES)[number];

export const GUARDRAIL_DEFAULT_MODE: GuardrailMode = "flag";

/** The neutral placeholder a masked span becomes. */
export const GUARDRAIL_MASK_PLACEHOLDER = "[masked]";

/** The forced-override env variable; unset/malformed means "no force". */
export const GUARDRAILS_MODE_FORCE_ENV = "MYRMIDON_GUARDRAILS_MODE_FORCE";

function isGuardrailMode(value: unknown): value is GuardrailMode {
  return typeof value === "string" && (GUARDRAIL_MODES as readonly string[]).includes(value);
}

// --- settings document -----------------------------------------------------

/** The `instance_settings.general` key this feature stores its settings under. */
export const GUARDRAIL_MODES_SETTINGS_KEY = "guardrailModes";

/**
 * The stored settings object: per-rule mode overrides at the company, caste
 * (role) and agent levels. Absent everywhere means flag-only everywhere.
 * The schema is `.strict()` so an unknown key fails loudly instead of
 * half-applying.
 */
/** A partial map of rules to modes — override only what is set. */
const ruleModesSchema = z.partialRecord(z.enum(GUARDRAIL_RULES), z.enum(GUARDRAIL_MODES));

/**
 * The stored settings object: per-rule mode overrides at the company, caste
 * (role) and agent levels. Absent everywhere means flag-only everywhere.
 * The schema is `.strict()` so an unknown key fails loudly instead of
 * half-applying.
 */
export const guardrailModesSettingsSchema = z
  .object({
    /** Company-wide overrides per rule. */
    company: ruleModesSchema.default({}),
    /** Caste (agent role) overrides: role -> rule -> mode. */
    castes: z.record(z.string().min(1), ruleModesSchema.default({})).default({}),
    /** Agent overrides: agentId -> rule -> mode. */
    agents: z.record(z.string().uuid(), ruleModesSchema.default({})).default({}),
  })
  .strict();

export type GuardrailModesSettings = {
  company: Partial<Record<GuardrailRule, GuardrailMode>>;
  castes: Record<string, Partial<Record<GuardrailRule, GuardrailMode>>>;
  agents: Record<string, Partial<Record<GuardrailRule, GuardrailMode>>>;
};

export const EMPTY_GUARDRAIL_MODES_SETTINGS: GuardrailModesSettings = {
  company: {},
  castes: {},
  agents: {},
};

/**
 * The settings as stored, or the implicit default (no overrides at all) when
 * absent or unreadable. A hand-edited row cannot half-apply: garbage resolves
 * to "every rule flag-only", the same safe default the layer ships with.
 */
export function normalizeGuardrailModesSettings(raw: unknown): GuardrailModesSettings {
  const parsed = guardrailModesSettingsSchema.safeParse(raw);
  if (parsed.success) {
    return {
      company: { ...parsed.data.company },
      castes: JSON.parse(JSON.stringify(parsed.data.castes)),
      agents: JSON.parse(JSON.stringify(parsed.data.agents)),
    };
  }
  return {
    company: {},
    castes: {},
    agents: {},
  };
}

// --- resolution ------------------------------------------------------------

/** Where a resolved mode came from — the UI shows this next to the value. */
export const GUARDRAIL_MODE_SOURCES = ["agent", "caste", "company", "default", "env"] as const;
export type GuardrailModeSource = (typeof GUARDRAIL_MODE_SOURCES)[number];

export interface ResolvedGuardrailMode {
  rule: GuardrailRule;
  mode: GuardrailMode;
  source: GuardrailModeSource;
  /**
   * The role that provided a caste-level value; null unless source is "caste".
   * The UI shows the concrete caste name next to an inherited value.
   */
  caste: string | null;
}

/**
 * Resolve the effective mode of one rule for one agent. Precedence:
 * env force > agent > caste > company > default (flag). An agent without a
 * role resolves as "no caste" (never matches a caste rule by accident); an
 * unknown rule resolves to the default rather than throwing, so a stored
 * document from a future version cannot break evaluation.
 */
export function resolveGuardrailMode(input: {
  settings: GuardrailModesSettings;
  rule: GuardrailRule;
  agentId: string;
  /** The agent's role (caste) label; null when the agent has no role. */
  agentRole: string | null;
  /** The forced env override: only a valid mode string forces; null/undefined = no force. */
  forced?: string | null;
}): ResolvedGuardrailMode {
  const ruleInput = input.rule;
  const rule: GuardrailRule = (GUARDRAIL_RULES as readonly string[]).includes(ruleInput)
    ? ruleInput
    : "secret";
  if (isGuardrailMode(input.forced)) {
    return { rule, mode: input.forced, source: "env", caste: null };
  }
  const agentRules = input.settings.agents[input.agentId];
  const agentMode = agentRules ? agentRules[rule] : undefined;
  if (isGuardrailMode(agentMode)) {
    return { rule, mode: agentMode, source: "agent", caste: null };
  }
  if (input.agentRole) {
    const casteRules = input.settings.castes[input.agentRole];
    const casteMode = casteRules ? casteRules[rule] : undefined;
    if (isGuardrailMode(casteMode)) {
      return { rule, mode: casteMode, source: "caste", caste: input.agentRole };
    }
  }
  const companyMode = input.settings.company[rule];
  if (isGuardrailMode(companyMode)) {
    return { rule, mode: companyMode, source: "company", caste: null };
  }
  return { rule, mode: GUARDRAIL_DEFAULT_MODE, source: "default", caste: null };
}

/**
 * Read the forced env value: only a valid mode string forces; anything else
 * (unset, blank, a typo) means "no force", so a mistake can never silently
 * rewrite the blocking policy.
 */
export function guardrailForcedModeFromEnv(env: { [key: string]: string | undefined }): GuardrailMode | null {
  const raw = env[GUARDRAILS_MODE_FORCE_ENV]?.trim().toLowerCase();
  return isGuardrailMode(raw) ? raw : null;
}
