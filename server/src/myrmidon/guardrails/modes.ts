// server/src/myrmidon/guardrails/modes.ts
//
// myrmidon(1.7-GRD-MODES): enforcement of the guardrail modes at the base
// layer's evaluation points (OPE-4167). The 1.6.1 layer was flag-only; this
// module resolves the effective mode of a rule for a run's agent and turns
// each detector firing into one of:
//
//   flag  — journal the event, change nothing (default);
//   mask  — replace the matched spans with a neutral placeholder;
//   block — refuse the output with a reason / keep the untrusted input out.
//
// Resolution order: env force > agent > caste (role) > company > flag. The
// settings are read per evaluation (no cache), so a mode change in the UI
// takes effect on the NEXT run answer without a restart — the acceptance
// criterion of OPE-4167.
//
// The block refusal text is deliberately operator-language, not user
// language: it says WHICH rule fired and how many hits, never the matched
// values themselves.

import { and, eq } from "drizzle-orm";
import { agents, instanceSettings, type Db } from "@paperclipai/db";
import {
  GUARDRAIL_DEFAULT_MODE,
  GUARDRAIL_MASK_PLACEHOLDER,
  GUARDRAIL_MODES_SETTINGS_KEY,
  guardrailForcedModeFromEnv,
  normalizeGuardrailModesSettings,
  resolveGuardrailMode,
  type GuardrailMode,
  type GuardrailModesSettings,
  type ResolvedGuardrailMode,
} from "@paperclipai/shared";

const INSTANCE_SETTINGS_SINGLETON_KEY = "default";

/** One rule's evaluation outcome, as consumed by an enforcement point. */
export interface GuardrailModeEnforcement {
  rule: "secret" | "pii" | "injection";
  mode: GuardrailMode;
  source: ResolvedGuardrailMode["source"];
  caste: string | null;
}

export interface ResolveGuardrailModesInput {
  db: Db;
  companyId: string;
  agentId: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Load the mode settings from instance_settings.general and resolve the
 * agent's role. Two primary-key reads per run finalization; failure to read
 * resolves to flag-only defaults, so the guardrail can never break a run by
 * failing to read its own policy.
 */
export async function loadGuardrailModes(
  input: ResolveGuardrailModesInput,
): Promise<{
  settings: GuardrailModesSettings;
  agentRole: string | null;
  forced: GuardrailMode | null;
}> {
  let rawSettings: unknown = undefined;
  let agentRole: string | null = null;
  try {
    const [row] = await input.db
      .select({ general: instanceSettings.general })
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, INSTANCE_SETTINGS_SINGLETON_KEY))
      .limit(1);
    const general = row?.general ?? {};
    rawSettings = general[GUARDRAIL_MODES_SETTINGS_KEY];
  } catch {
    rawSettings = undefined;
  }
  try {
    const [agentRow] = await input.db
      .select({ role: agents.role })
      .from(agents)
      .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)))
      .limit(1);
    agentRole = agentRow?.role ?? null;
  } catch {
    agentRole = null;
  }
  return {
    settings: normalizeGuardrailModesSettings(rawSettings),
    agentRole,
    forced: guardrailForcedModeFromEnv(input.env ?? process.env),
  };
}

/**
 * Resolve one rule's mode for one agent, loading settings from the database.
 * Returns the flag-only default on any read failure.
 */
export async function resolveGuardrailModeForAgent(
  input: ResolveGuardrailModesInput & { rule: "secret" | "pii" | "injection" },
): Promise<GuardrailModeEnforcement> {
  const loaded = await loadGuardrailModes(input);
  const resolved = resolveGuardrailMode({
    settings: loaded.settings,
    rule: input.rule,
    agentId: input.agentId,
    agentRole: loaded.agentRole,
    forced: loaded.forced,
  });
  return {
    rule: resolved.rule,
    mode: resolved.mode,
    source: resolved.source,
    caste: resolved.caste,
  };
}

/** Mask every hit span (non-overlapping, already resolved by the detector) with the neutral placeholder. */
export function maskGuardrailSpans(
  text: string,
  hits: ReadonlyArray<{ span: [number, number] }>,
): string {
  if (hits.length === 0) return text;
  const spans = [...hits]
    .map((hit) => hit.span)
    .sort((a, b) => a[0] - b[0]);
  let out = "";
  let cursor = 0;
  for (const [start, end] of spans) {
    const from = Math.max(cursor, Math.min(start, text.length));
    const to = Math.max(from, Math.min(end, text.length));
    if (from > cursor) out += text.slice(cursor, from);
    if (to > from) out += GUARDRAIL_MASK_PLACEHOLDER;
    cursor = Math.max(cursor, to);
  }
  if (cursor < text.length) out += text.slice(cursor);
  return out;
}

/** The visible refusal a blocked run output is replaced with. */
export function guardrailBlockRefusal(input: {
  rule: "secret" | "pii" | "injection";
  hits: number;
  source: ResolvedGuardrailMode["source"];
}): string {
  const ruleWord = input.rule === "pii" ? "personal data" : input.rule;
  return (
    `This run's answer was withheld by the ${ruleWord} guardrail ` +
    `(${input.hits} ${input.hits === 1 ? "hit" : "hits"}, mode set at ${input.source} level). ` +
    `The run itself finished; only its visible answer was refused. ` +
    `The operator can change the rule's mode in Company Settings → Guardrails.`
  );
}

export { GUARDRAIL_DEFAULT_MODE };
