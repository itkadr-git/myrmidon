import { z } from "zod";

export const guardrailRuleTypeSchema = z.enum([
  "secret",
  "pii",
  "injection",
  "regex",
  "content",
  "custom",
]);
export type GuardrailRuleType = z.infer<typeof guardrailRuleTypeSchema>;

export const guardrailRuleStatusSchema = z.enum([
  "active",
  "disabled",
  "draft",
  "archived",
]);
export type GuardrailRuleStatus = z.infer<typeof guardrailRuleStatusSchema>;

export const guardrailRuleModeSchema = z.enum(["block", "mask", "flag", "warn"]);
export type GuardrailRuleMode = z.infer<typeof guardrailRuleModeSchema>;

export const guardrailRuleSurfaceSchema = z.enum(["input", "output", "all"]);
export type GuardrailRuleSurface = z.infer<typeof guardrailRuleSurfaceSchema>;

export const guardrailRuleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  type: guardrailRuleTypeSchema,
  status: guardrailRuleStatusSchema,
  mode: guardrailRuleModeSchema.default("flag").optional(),
  surface: guardrailRuleSurfaceSchema.default("all").optional(),
  pattern: z.string().nullable().optional(),
  config: z.record(z.unknown()).nullable().optional(),
  companyId: z.string().nullable().optional(),
  createdAt: z.string().datetime().or(z.date()).optional(),
  updatedAt: z.string().datetime().or(z.date()).optional(),
});
export type GuardrailRule = z.infer<typeof guardrailRuleSchema>;

export const listGuardrailRulesQuerySchema = z.object({
  status: guardrailRuleStatusSchema.optional(),
  type: guardrailRuleTypeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50).optional(),
  cursor: z.string().min(1).optional(),
});
export type ListGuardrailRulesQuery = z.infer<typeof listGuardrailRulesQuerySchema>;

export const listGuardrailRulesResponseSchema = z.object({
  rules: z.array(guardrailRuleSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().min(0).optional(),
});
export type ListGuardrailRulesResponse = z.infer<typeof listGuardrailRulesResponseSchema>;
