import { z } from "zod";

export const GUARDRAIL_RULES = ["secrets_output", "pii_output", "prompt_injection_input"] as const;
export const GUARDRAIL_MODES = ["flag_only", "mask", "block"] as const;
export const GUARDRAIL_LEVELS = ["company", "caste", "agent"] as const;
export type GuardrailRule = (typeof GUARDRAIL_RULES)[number];
export type GuardrailMode = (typeof GUARDRAIL_MODES)[number];
export type GuardrailLevel = (typeof GUARDRAIL_LEVELS)[number];

export const guardrailModeSchema = z.object({
  rule: z.enum(GUARDRAIL_RULES),
  mode: z.enum(GUARDRAIL_MODES),
});

export interface GuardrailOverride {
  level: GuardrailLevel;
  targetId: string;
  rule: GuardrailRule;
  mode: GuardrailMode;
}

export interface EffectiveGuardrailMode {
  rule: GuardrailRule;
  mode: GuardrailMode;
  source: GuardrailLevel | "default";
}

export function resolveGuardrailMode(
  rule: GuardrailRule,
  overrides: readonly GuardrailOverride[],
): EffectiveGuardrailMode {
  for (const level of GUARDRAIL_LEVELS.slice().reverse()) {
    const match = overrides.find((item) => item.rule === rule && item.level === level);
    if (match) return { rule, mode: match.mode, source: level };
  }
  return { rule, mode: "flag_only", source: "default" };
}
